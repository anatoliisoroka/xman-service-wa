import { WAMessage, WAChat, WAConnectionState, WAUser, WAGroupMetadata, Presence, AuthenticationCredentialsBase64, MessageOptions, WAMessageContent, WAContact } from "@adiwajshing/baileys"
import { Static } from 'runtypes'
import { MessageFlowCreateOptions, MessageComposeOptions, MessageComposeOptionsFlow, FileContent, MessageFlowEditOptions, ContactUpdatedOptions } from './Runtypes'
import KeyedDB from "@adiwajshing/keyed-db"

export const xman_SERVICE_ID = 'xman'

export interface WAAccountInfo {
    id: string
    creds?: AuthenticationCredentialsBase64,
    lastConnect?: Date
    autoReconnect?: boolean
    lastKnownUser?: WAUser
}

export interface WADisconnectResponse {
    disconnect: string
}
export type WACompleteMessage = WAMessage & {
    scheduled?: boolean
    withTyping?: boolean
    note?: {
        edits: {author: string, timestamp: number}[]
    }
    tag?: string
}
export interface xmanContact {
    phone: string
    name: string
    tags: { name: string }[]
    assignee: string
}
export type WACompleteChat = WAChat & {
    messages: KeyedDB<WACompleteMessage, string>
}
export type WACompleteContact = WAContact & { profile?: xmanContact }
export type WAData = { chats: KeyedDB<WAChat, string>, contacts: { [jid: string]: WAContact } }

export interface WAState {
    connections: {
        phone: boolean,
        waWeb: WAConnectionState
    },
    chats: {
        hasSome: boolean
        hasLatest: boolean
    },
    canLogin: boolean,
    user: WAUser,
    pendingQR?: string,
    mediaUploadsUrl: string
}

export type WAMessageContentInfo = { content: WAMessageContent, options: MessageOptions }

export interface WAMessageSendOptions extends Static<typeof MessageComposeOptions> {}
export interface WAMessageSendOptionsFlow extends Static<typeof MessageComposeOptionsFlow> {}
export interface WAMessageFlow extends Static<typeof MessageFlowCreateOptions> {
    id: string
}
export interface WAMessageFlowCreateOptions extends Static<typeof MessageFlowCreateOptions> { }
export interface WAMessageFlowEditOptions extends Static<typeof MessageFlowEditOptions> { }
export interface WAFileContent extends Static<typeof FileContent> { }

export interface ContactsUpdatedData extends Static<typeof ContactUpdatedOptions> {  }

export type PreparedChat = WACompleteChat & { messages: WACompleteMessage[], profile?: xmanContact }