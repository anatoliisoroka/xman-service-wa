import { WAConnection as Base } from './1.Scheduling'
import { WAMessageContent, whatsappID, generateMessageID, unixTimestampSeconds, toNumber, newMessagesDB, WAMessage, WA_MESSAGE_STUB_TYPE, WAChat } from '@adiwajshing/baileys';
import { WACompleteMessage } from '../Internal/Constants';
import { mergeSortedArrays } from '../Internal/Utils'

const MAX_EDIT_HISTORY = 20
const constructNotesQuery = (chats: { jid: string, messages: WAMessage[] }[], isMostRecentPage: boolean) => {
    return (
        chats.map(({jid, messages}) => {
            const before = (!isMostRecentPage && messages[messages.length-1]) && toNumber(messages[messages.length-1]?.messageTimestamp)
            const till = messages[0]?.messageTimestamp && toNumber(messages[0]?.messageTimestamp)
            return { jid, before, till }
        }, {})
    )
}
/**
 * Code for creating notes
 * Notes are messages that are kept in your message history but never sent to the other person
 */
export class WAConnection extends Base {

    async noteNew (jid: string, message: WAMessageContent, author: string, tag?: string) {
        jid = whatsappID (jid)
        this.assertChatGet (jid)

        const note = {
            key: { id: generateMessageID(), fromMe: true, remoteJid: jid },
            message: message,
            messageTimestamp: unixTimestampSeconds (),
            status: 1,
            note: {
                edits: []
            },
        } as WACompleteMessage
        return this.noteAdd(note, author, tag)
    }
    async noteNewProtocolMessage (jid: string, stubType: string, parameters: string[], author: string) {
        const note = {
            key: { id: generateMessageID(), fromMe: true, remoteJid: jid },
            messageStubParameters: parameters,
            messageStubType: stubType as any as WA_MESSAGE_STUB_TYPE,
            messageTimestamp: unixTimestampSeconds (),
            status: 1,
            note: {
                edits: []
            },
            participant: author
        } as WACompleteMessage

        this.addNoteEdit (note, author)
        await this.store.notesSet (note.key.remoteJid, note.key.id, note)

        return note
    }
    async noteEdit (jid: string, noteId: string, edit: { text?: string, delete?: boolean }, author: string) {
        const note = await this.store.notesGet (jid, noteId)
        if (!note) throw new Error (`note ${noteId} not found`)

        if (edit.text) {
            note.message = {
                extendedTextMessage: {
                    text: edit.text
                }
            }
            delete note.messageStubType
        } else if (edit.delete) {
            delete note.message
            note.messageStubType = 1
        } else throw new Error (`invalid edit for ${noteId}`)
        
        this.addNoteEdit (note, author)
        
        this.emit ('chat-update', { jid, messages: newMessagesDB([ note ]) })

        await this.store.notesSet (jid, noteId, note)

        return note
    }
    async loadMessagesAllKinds (jid: string, count: number, before?: string) {
        jid = whatsappID (jid)
        let {messages, cursor} = await super.loadMessagesAllKinds (jid, count, before)

        const notesResults = await this.store.notesLoad (
            constructNotesQuery([ { jid, messages } ], !before)
        )
        const notes = notesResults[jid] || []

        messages = mergeSortedArrays (notes, messages, (a, b) => toNumber(a.messageTimestamp)-toNumber(b.messageTimestamp))

        return {messages, cursor}
    }
    async prepareChatsForSending (chats: WAChat[]) {
        const prepped = await super.prepareChatsForSending(chats)
        const notes = await this.store.notesLoad(
            constructNotesQuery(prepped, true)
        )
        prepped.forEach(chat => notes[chat.jid] && (
            chat.messages = mergeSortedArrays (notes[chat.jid], chat.messages, (a, b) => toNumber(a.messageTimestamp)-toNumber(b.messageTimestamp)) as any
        ))
        return prepped
    }

    protected async noteAdd (note: WAMessage, author: string, tag?: string) {
        this.addNoteEdit (note, author)
        await this.store.notesSet (note.key.remoteJid, note.key.id, note)

        if (tag) note['tag'] = tag
        this.emit ('chat-update', { jid: note.key.remoteJid, messages: newMessagesDB([ note ]) })

        return note
    }

    protected addNoteEdit (note: WACompleteMessage, author: string) {
        const row = { author, timestamp: unixTimestampSeconds() }
        note.note.edits.splice (0, 0, row)
        note.note.edits = note.note.edits.slice (0, MAX_EDIT_HISTORY)
    }
}