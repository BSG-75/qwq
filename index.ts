import MiraiTs, { MiraiApiHttpConfig } from 'mirai-ts'
import { Mutex } from 'async-mutex'
import yargs from 'yargs'
import { readFileSync } from 'fs'
import { Member } from 'mirai-ts/dist/types/contact'
import { Plain } from 'mirai-ts/dist/types/message-type'

const args = yargs.option('config', {
  alias: 'c',
  description: 'path to the config json',
  type: 'string'
}).help().alias('help', 'h').argv

type ExpectedType<T extends (arg: unknown) => unknown> =
  T extends (arg: unknown) => arg is infer R ? R : never
type Definition = Record<string, (arg: unknown) => unknown>
export type FromDefinition<D extends Definition> = {
  [K in keyof D]: ExpectedType<D[K]>
}
export const getTypeChecker = <D extends Definition>(d: D) => {
  const keys = Object.keys(d) as (keyof Definition)[]
  return (e: unknown): e is FromDefinition<D> => {
    return typeof e === 'object' && keys.every(k => {
      return d[k]((e as any)[k])
    })
  }
}
const configDefinition = {
  qq: (x: unknown): x is number => typeof x === 'number',
  mahConfig: (x: unknown): x is MiraiApiHttpConfig => typeof x === 'object',
  groups: (x: unknown): x is number[] => Array.isArray(x) && x.every(e => typeof e === 'number')
}
const parseConfig = () => {
  if (typeof args.config !== 'string') {
    throw new Error('missing config path')
  }
  const parsed = JSON.parse(readFileSync(args.config).toString('utf-8'))
  const configChecker = getTypeChecker(configDefinition)
  if (!configChecker(parsed)) {
    throw new Error('Invalid config')
  }
  return parsed
}

const { qq, mahConfig, groups: groupNumbers } = parseConfig();
const mirai = new MiraiTs(mahConfig)

type StoredMessage = {
  id: number
  author: number
}

class StoredMessages {
  private threshold = 200
  private data = [new Map<number, StoredMessage>(), new Map<number, StoredMessage>()]
  private currentIndex = 0
  private otherIndex = 1
  private get current() { return this.data[this.currentIndex] }
  private get other() { return this.data[this.otherIndex] }

  public add(original: number, translated: StoredMessage) {
    if (this.current.size > this.threshold) {
      // 假如保存的消息过多，那么把另一个 buffer （老数据）给清空后拿来使用
      [this.currentIndex, this.otherIndex] = [this.otherIndex, this.currentIndex]
      this.current.clear()
    }
    const current = this.current
    current.set(original, translated)
  }

  public translate(messageId: number) {
    return this.current.get(messageId) || this.other.get(messageId)
  }
}

async function app() {
  // 登录 QQ
  await mirai.link(qq);

  const groups = groupNumbers.map(group => ({
    group,
    members: new Map<number, string>(),
    stored: new StoredMessages(),
    async updateMemberList() {
      const list: Member[] = await mirai.api.memberList(this.group)
      this.members = new Map(list.map(m => [m.id, m.memberName]))
    }
  }));
  // 保存成员列表
  await Promise.all(groups.map(g => g.updateMemberList()))

  const mutex = new Mutex()
  // 对收到的消息进行处理
  // message 本质相当于同时绑定了 FriendMessage GroupMessage TempMessage
  // 你也可以单独对某一类消息进行监听
  mirai.on('GroupMessage', async (msg) => {
    const fromGroup = msg.sender.group.id
    if (!groups.find(({ group }) => group === fromGroup)) {
      return
    }
    const messageId = msg.messageChain[0].id
    const messageAuthor = msg.sender.id
    const originalGroup = groups.find(({ group }) => group === fromGroup)

    const releaseMutex = await mutex.acquire()
    try {
      const promises = groups
        .filter(({ group }) => group !== fromGroup)
        .map(async ({ group, stored, members }) => {
          let quote: StoredMessage | undefined
          let atMeCounter = 0
          const processed = msg.messageChain.filter(x => {
            // 处理 @
            if (x.type === 'At') {
              // 避免转发回复时的 @
              if (quote && x.target === qq) {
                return atMeCounter++ === 0
              }
              return true
            }
            // 处理回复
            if (x.type !== 'Quote') {
              return true
            }
            quote = stored.translate(x.id) || quote
            return false
          }).map(x => {
            // 处理 @
            if (x.type !== 'At') {
              return x
            }

            if (x.target === qq) {
              x = { ...x, target: quote?.author || qq }
            }

            // 转发的消息不应该继续 @ 人，因为人可能并不在被转发的群
            // 就算在，被好几个群同时 @，也很奇怪（
            // 因此，除非是为了回复的 @，否则一律转成纯文本
            // 就算确实是为了回复的 @，假如转发的群里这个人不在，那也转成纯文本
            if (x.target !== quote?.author || !members.has(x.target)) {
              // 把 @ 转换成纯文本的时候，优先使用哪个群里的群名片
              const searchFrom = originalGroup
                ? [members, originalGroup.members]
                : [members]
              searchFrom.push(...groups.map(x => x.members))

              let name = x.display
              for (const members of searchFrom) {
                const match = members.get(x.target)
                if (match) {
                  name = match
                  break
                }
              }

              return { type: 'Plain' as const, text: `@${name}` }
            }

            return x
          })

          try {
            const sent = await mirai.api.sendGroupMessage(processed, group, quote?.id)
            return { sentId: sent.messageId, targetStorage: stored }
          }
          catch (e) {
            console.warn(`${JSON.stringify(e)}; type = ${typeof e}; ${e.constructor?.name}`)
          }
        })

      const results = (await Promise.all(promises))
        .filter(<T>(x?: T): x is T => x !== undefined)
      for (const { sentId, targetStorage } of results) {
        const others = results.filter(other => other.targetStorage !== targetStorage)
        for (const other of others) {
          targetStorage.add(other.sentId, { author: messageAuthor, id: sentId })
        }
        targetStorage.add(messageId, { author: messageAuthor, id: sentId })
        originalGroup?.stored?.add(sentId, { author: messageAuthor, id: messageId })
      }
    }
    finally {
      releaseMutex();
    }
  })

  // 调用 mirai-ts 封装的 mirai-api-http 发送指令
  /*console.log("send command help");
  const data = await mirai.api.command.send("help", []);
  console.log("帮助信息:" + data);*/

  // 处理各种事件类型
  // 事件订阅说明（名称均与 mirai-api-http 中事件名一致）
  // https://github.com/RedBeanN/node-mirai/blob/master/event.md
  // console.log("on other event");
  // https://github.com/project-mirai/mirai-api-http/blob/master/EventType.md#群消息撤回
  mirai.on("GroupRecallEvent", ({ operator }) => {
    if (operator) {
      const text = `${operator.memberName} 撤回了一条消息，并拜托你不要再发色图了。`;
      console.log(text);
      mirai.api.sendGroupMessage(text, operator.group.id);
    }
  });

  // 开始监听
  mirai.listen();
  // 可传入回调函数对监听的函数进行处理，如：
  // mirai.listen((msg) => {
  //   console.log(msg)
  // })
}

app();