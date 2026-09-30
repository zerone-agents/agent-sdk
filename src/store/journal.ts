/** OperationJournal——SDK→宿主的提交编排接口（issue #131 spec §5.1）。 */
import type { PreparedOperation } from './types.js'

export interface OperationJournal {
  /** prepare 之后、commit 之前——宿主把完整 prepared 持久化进 durable journal */
  persist(prepared: PreparedOperation): Promise<void>
  /** commit 成功后——宿主清除 journal 条目（完成 pending 交接） */
  release(operationId: string): Promise<void>
}

/** 默认 no-op（无宿主 journal 时 inline prepare → commit） */
export class NoopJournal implements OperationJournal {
  async persist(): Promise<void> {}
  async release(): Promise<void> {}
}