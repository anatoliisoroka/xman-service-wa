import { describeWithConnection, TEST_JID } from "./Common";
import assert from 'assert'
import { WAMessageContent, MessageType, WA_MESSAGE_STUB_TYPE } from "@adiwajshing/baileys";

describeWithConnection ('WA Notes', false, conn => {

    const createNote = async () => {
        const waitForNoteUpdate = new Promise (resolve => {
            conn.on ('note-new', note => {
                conn.removeAllListeners ('note-new')
                resolve (note)
            })
        })
        const noteContent: WAMessageContent = { extendedTextMessage: { text: 'cool note' } }
        
        const note = await conn.noteNew (TEST_JID, noteContent, 'some-author')
        assert.ok (note.key?.id)
        assert.ok (note.note)
        assert.equal (note.key?.remoteJid, TEST_JID)
        assert.equal (note.message.extendedTextMessage?.text, noteContent.extendedTextMessage.text)

        await waitForNoteUpdate
        return note
    }
    it ('should create a new note', async () => {
        const note = await createNote ()

        const { messages } = await conn.loadMessagesAllKinds (TEST_JID, 10)
        const rNote = messages.find (m => m.key.id === note.key.id)
        
        assert.ok (rNote)
        assert.ok (rNote.note)
        assert.ok (rNote.note.edits[0]?.author)

        //await conn.noteEdit (TEST_JID, { text: 'edited note' }, 'some-author-2')
        const sent = await conn.sendMessage (TEST_JID, 'test message', MessageType.extendedText)
        const messages2 = await conn.loadMessagesAllKinds (TEST_JID, 15)

        const sentIdx = messages2.messages.findIndex (m => m.key.id === sent.key.id)
        const noteIdx = messages2.messages.findIndex (m => m.key.id === note.key.id)

        assert.ok (sentIdx)
        assert.ok (noteIdx)
        assert.ok (sentIdx > noteIdx)
    })

    it ('should edit a note', async () => {
        const { messages } = await conn.loadMessagesAllKinds (TEST_JID, 10)
        const note = messages.find (m => m.note) || await createNote ()

        const editOptions = {
            text: 'this is an even cooler note'
        }
        const waitForNoteUpdate = new Promise (resolve => {
            conn.on ('note-edit', n => {
                if (n.key.id === note.key.id) resolve (n)
            })
        })
        const editedNote = await conn.noteEdit (TEST_JID, note.key.id, editOptions, 'author-2')
        assert.equal (editedNote.key.id, note.key.id)
        assert.equal (editedNote.message.extendedTextMessage.text, editOptions.text)

        assert.ok (editedNote.note.edits.length >= 2)

        await waitForNoteUpdate

        const messages2 = await conn.loadMessagesAllKinds (TEST_JID, 10)
        assert.equal (
            messages2.messages.find(m => m.key.id === note.key.id)?.message.extendedTextMessage.text, 
            editOptions.text
        )
    })
    it ('should delete a note', async () => {
        const {messages} = await conn.loadMessagesAllKinds (TEST_JID, 10)
        const note = messages.find (m => m.note) || await createNote ()

        const editOptions = {
            delete: true
        }
        const editedNote = await conn.noteEdit (TEST_JID, note.key.id, editOptions, 'author-3')
        assert.equal (editedNote.key.id, note.key.id)
        assert.equal (editedNote.message, undefined)
        assert.equal (editedNote.messageStubType, 1) // marked deleted

        assert.ok (editedNote.note.edits.length >= 2)

        const messages2 = await conn.loadMessagesAllKinds (TEST_JID, 10)
        assert.equal (
            messages2.messages.find(m => m.key.id === note.key.id)?.messageStubType, 
            WA_MESSAGE_STUB_TYPE.REVOKE
        )
    })
})