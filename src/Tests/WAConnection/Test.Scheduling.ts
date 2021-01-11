import assert from 'assert'
import { describeWithConnection, TEST_JID, textMessageTemplate } from './Common'
import { unixTimestampSeconds, delay, WA_MESSAGE_STUB_TYPE, WA_MESSAGE_STATUS_TYPE } from '@adiwajshing/baileys'

describeWithConnection ('WA Scheduling', false, conn => {
    it ('should schedule a message', async () => {
        const message = await textMessageTemplate (conn, 'this will arrive soon', new Date(new Date().getTime() + 15*1000))
        await conn.relayWAMessage (message)

        const {messages} = await conn.loadMessagesAllKinds (TEST_JID, 15)
        const messageIdx = messages.findIndex (m => m.key.id === message.key.id)

        assert.ok (messages[messageIdx])
        assert.ok (messages[messageIdx].scheduled)
        assert.equal (messages.slice(messageIdx).filter(m => !m.scheduled).length, 0)

        await new Promise (resolve => {
            conn.on ('message-update', (m) => {
                if (m.ids.includes(message.key.id)) resolve ()
            })
        })
        const messages2 = await conn.loadMessagesAllKinds (TEST_JID, 10)
        const retreived = messages2.messages.find(m => m.key.id === message.key.id)
        assert.ok (retreived)
        assert.ok (!retreived.scheduled)
        assert.ok ((retreived.messageTimestamp as number)*1000 >= (message.messageTimestamp as number))
        assert.ok (unixTimestampSeconds() >= (retreived.messageTimestamp as number))
    })
    it ('should cancel a scheduled message', async () => {
        const message = await textMessageTemplate (conn, 'this will never arrive', new Date(new Date().getTime() + 15*1000))
        await conn.relayWAMessage (message)

        assert.ok (message['scheduled'])

        await delay (5000)

        const deletion = new Promise (resolve => {
            conn.on ('message-update', m => {
                if (m.ids.includes(message.key.id)) {
                    assert.ok(m.type, 'delete')
                    resolve ()
                }
            })
        })
        const del = await conn.deleteMessage (TEST_JID, message.key)
        assert.equal (del.messageStubType, WA_MESSAGE_STUB_TYPE.REVOKE)
        await deletion
        await delay (15000) // wait for 15 seconds more to ensure that the message is not sent

        const {messages} = await conn.loadMessagesAllKinds (TEST_JID, 15)
        assert.equal (messages.find(m => m.key.id === del.key.id), undefined)
    })
    it ('should reschedule a scheduled message', async () => {
        const message = await textMessageTemplate (conn, 'this will arrive sooner than expected', new Date(new Date().getTime() + 25*1000))
        const newTime = (message.messageTimestamp as number) - 10 // 10 seconds before
        
        await conn.relayWAMessage (message)
        await conn.rescheduleMessage (TEST_JID, message.key.id, newTime)

        await new Promise (resolve => {
            conn.on ('message-update', m => {
                if (m.ids.includes(message.key.id)) resolve ()
            })
        })
        const curTime = unixTimestampSeconds ()
        assert.ok (curTime < newTime+2) // should be sent at the right time
    })
    it ('should send a scheduled message after reboot', async () => {
        const message = await textMessageTemplate(conn, 'this will arrive v soon', new Date(new Date().getTime() + 15*1000))
        await conn.relayWAMessage (message)

        await delay (1000)

        conn.close ()

        console.log ('closed connection')

        await delay (10000) // shutdown for longer than scheduled

        const wait = new Promise (resolve => {
            conn.on ('message-update', m => {
                if (m.ids.includes(message.key.id) && m.type === WA_MESSAGE_STATUS_TYPE.SERVER_ACK) resolve (m)
            })
        })
        const wait2 = new Promise (resolve => {
            conn.on ('message-update', m => {
                // wait for message delivery
                if (m.ids.includes(message.key.id) && m.type >= WA_MESSAGE_STATUS_TYPE.DELIVERY_ACK) resolve ()
            })
        })

        await conn.connect ()
        
        await wait

        console.log ('confirm scheduled message')

        await wait2
    })
})