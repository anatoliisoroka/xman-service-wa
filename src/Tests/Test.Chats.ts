import assert from 'assert'
import { delay } from "@adiwajshing/baileys";
import { describeWithServer, request, waitForOpen } from "./Common";
import { WACompleteChat, WAState } from '../Internal/Constants';

describeWithServer ('Chats', app => {

    const getFirstChat = async () => {
        await waitForOpen ()

        const {chats}: {chats: WACompleteChat[]} = await request (`/chats`, 'GET') 
        assert.ok (chats[0])
        assert.ok (chats[0].messages.length <= 1)
        return chats[0]
    }

    it ('should update user status', async () => {
        const state = await waitForOpen ()
        const old = await request (`/user/status/${state.user.jid}`, 'GET')

        const newStatus = { status: 'this is a new status yo' }
        await request (`/user/status`, 'PATCH', newStatus)

        assert.equal (
            newStatus.status,
            (await request(`/user/status/${state.user.jid}`, 'GET')).status
        )

        await request (`/user/status`, 'PATCH', old)
    })
    it ('should get paginated chats correctly', async () => {
        await request (`/chats`, 'GET') // should not fail
        await waitForOpen ()

        let chats: WACompleteChat[] = []
        let cursor
        do {
            const obj: {chats: WACompleteChat[], cursor} = await request (`/chats?count=5${ cursor ? `&before=${cursor}` : '' }`, 'GET')
            assert.deepEqual (
                chats.filter (({jid}) => obj.chats.find(flow => flow.jid === jid)),
                []
            )
            chats = [...chats, ...obj.chats]
            cursor = obj.cursor
            await delay (500)
        } while (cursor)
    })
    it ('should get a single chat', async () => {
        const firstChat = await getFirstChat ()
        const chat: WACompleteChat = await request (`/chats/${firstChat.jid}`, 'GET') 
        assert.deepEqual (chat, firstChat)
    })

    it ('should modify a chat', async () => {
        const modifications = ['archive', 'unarchive', 'pin', 'unpin', 'mute', 'unmute']
        const firstChat = await getFirstChat ()

        for (let mod of modifications) {
            await request (`/chats/${firstChat.jid}`, 'PATCH', { modification: mod })
            await delay (1000)
            const chat: WACompleteChat = await request (`/chats/${firstChat.jid}`, 'GET') 
            if (!mod.startsWith('un')) {
                assert.ok (chat[mod])
            }
        }
    })
    it ('should update my picture', async () => {
        const state = await waitForOpen ()
        const jid = state.user.jid
        
        await request (`/user/picture/${jid}`, 'PATCH', 
            {
                picture: {
                    url: 'https://www.memestemplates.com/wp-content/uploads/2020/05/tom-with-phone.jpg',
                    mimetype: 'image/jpeg',
                    name: 'tom.jpeg'
                }
            }
        )
    })

    it ('should read/unread a chat', async () => {
        const firstChat = await getFirstChat ()
        // mark read
        await request (`/chats/${firstChat.jid}/read`, 'POST', { read: 'true' })
        let chat: WACompleteChat = await request (`/chats/${firstChat.jid}`, 'GET') 
        assert.equal (chat.count, 0)
        // mark unread
        await request (`/chats/${firstChat.jid}/read`, 'POST', { read: 'false' })
        chat = await request (`/chats/${firstChat.jid}`, 'GET') 
        assert.ok (chat.count < 0)
        // mark read again
        await request (`/chats/${firstChat.jid}/read`, 'POST', { read: 'true' })
        chat = await request (`/chats/${firstChat.jid}`, 'GET') 
        assert.equal (chat.count, 0)
    })

})