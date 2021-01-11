import { describeWithConnection, assertChatDBIntegrity, TEST_JID, assertMessagesIntegrity } from "./Common";
import { isGroupID, MessageType, delay, whatsappID, toNumber } from "@adiwajshing/baileys";
import assert from 'assert'
import { WACompleteMessage } from "../Internal/Constants";

describeWithConnection ('Misc', true, conn => {

    it ('should have participant names', async () => {
        // get first 10 group chats
        const groupChats = conn.chats.all().filter (({jid}) => isGroupID(jid)).slice (0, 10)
        for (let chat of groupChats) {
            let {participants} = await conn.groupMetadataExtended (chat.jid)
            for (let participant of participants) {
                assert.ok (participant.name, `participant name not set for ${chat.jid}, ${participant}`)
            }
        }
    })

    it ('should get messages while disconnected', async () => {
        // send some messages
        const messages = await Promise.all (
            [...Array (5)].map (async (_, i) => {
                const m = await conn.sendMessage (TEST_JID, 'test ' + i, MessageType.text)
                return m.key.id
            })
        )
        conn.close ()
        await delay (1000)
        // make the store think its been asleep for much longer
        await conn.store.setLastConnectionDate (new Date( new Date().getTime()-60*1000 ))

        const task: Promise<WACompleteMessage[]> = new Promise (resolve => conn.on('messages-post-sleep', resolve))

        await conn.connect ()
        const sleepMessages = await task
        console.log (sleepMessages)
        for (let m of messages) {
            assert.ok(sleepMessages.find (message => message.key.id === m))
        }

        // should be no sleep messages now
        conn.close ()
        await delay (1000)

        const task2: Promise<WACompleteMessage[]> = new Promise (resolve => conn.on('messages-post-sleep', resolve))

        await conn.connect ()
        const sleepMessages2 = await task2
        assert.deepEqual (sleepMessages2, [])
    })

    it ('should order chats correctly', async () => {
        // pre-load some messages
        await conn.loadMessagesAllKinds (TEST_JID, 25)

        conn.on ('message-new', async message => {
            const {messages} = await conn.loadMessagesAllKinds (message.key.remoteJid, 25)

            /*console.log (
                messages.map (m => ({
                    text: m.message?.conversation || m.message?.extendedTextMessage?.text,
                    stamp: toNumber (m.messageTimestamp)
                }))
            )*/

            assertMessagesIntegrity (messages)
            console.log ('asserted integrity')
        })

        const chat = conn.chats.get (TEST_JID)
        for (let i = 0;i < 10;i++) {
            if (i % 5 === 0) {
                await conn.noteNew (TEST_JID, { extendedTextMessage: { text: `this is a note` } }, 'adi')
                continue
            }
            const message = await conn.prepareMessage (TEST_JID, `test: ${i}`, MessageType.text)

            conn['chatAddMessage'](message, chat)
            await delay (50)
        }
        await delay (1000)
    })

})