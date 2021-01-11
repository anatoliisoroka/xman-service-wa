import { WACompleteMessage, WAMessageFlow, WAMessageFlowCreateOptions, WAAccountInfo, xmanContact, WAData} from "../Internal/Constants"
import { Agent } from "https";
import { Logger } from "pino";
/**
 * Generic interface for WA Functions
 */
export interface Store {
    teamId: string
    serviceId: string

    init: (id: string) => Promise<void>
    close?: () => Promise<void>

    prepareCloudWatchLogger (logger: Logger)

    setWAData: (key: Buffer, data: WAData) => Promise<void>
    getWAData: (key: Buffer) => Promise<WAData>

    getAuthToken (): Promise<string> 
    getAgent (): Promise<Agent> 
    fetchContacts (contacts: string[]): Promise<xmanContact[]>

    webhooks (event: string): Promise<string[]>

    messageFlowSet: (id: string, flow: WAMessageFlow | WAMessageFlowCreateOptions | null) => Promise<WAMessageFlow>
    messageFlowGet: (id: string) => Promise<WAMessageFlow>
    messageFlowsLoad: (count: number, afterID?: string, searchString?: string) => Promise<{flows: WAMessageFlow[], cursor?: string}>
    
    getInfo: () => Promise<WAAccountInfo>
    setInfo: (info?: Partial<WAAccountInfo>) => Promise<void>

    mediaMessageExists: (fileID: string) => Promise<boolean>
    setMediaMessage: (fileID: string, content: Buffer) => Promise<void>
    urlForMediaMessage: (messageID: string) => string

    pendingMessagesLoad: () => Promise<WACompleteMessage[]>
    /** Delete when message is null */
    pendingMessageSet: (messageID: string, message: WACompleteMessage | null) => Promise<void>

    notesLoad: (chats: { jid: string, before: number | null, till: number | null }[]) => Promise<{ [jid: string]: WACompleteMessage[] }>
    notesGet: (jid: string, noteID: string) => Promise<WACompleteMessage>
    notesSet: (jid: string, noteID: string, note: WACompleteMessage | null) => Promise<void>
}