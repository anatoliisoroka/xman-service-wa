import { Record, String, Array, Number, Static, Partial, Boolean, Literal, Union, Unknown, Dictionary, Undefined, Null } from 'runtypes'
import { MessageType } from '@adiwajshing/baileys'

/** Contains all the types that are used for request validation */

export type APIUser = {
    teamId: string
    id: string
    token: string
}

/// GENERICS -------------

/** A string safe to insert into an SQL DB */
const SQLSafeString = String.withGuard (function (x): x is string {
    return !x.includes ("'") && !x.includes ("\'")
})
/** A string that is some JID */
const JIDString = SQLSafeString.withGuard (function (x): x is string {
    return (x.endsWith ('@s.whatsapp.net') || x.endsWith('@g.us') || x.endsWith('@broadcast')) && x.length <= 50
})
/** A string that is a number */
const SNumber = String.withGuard (function (x): x is string {
    return !!parseInt (x)
})
const SNumberRanged = (min: number, max: number) => String.withGuard (function (x): x is string {
    const num = parseInt (x)
    return num >= min && num < max
})
const StringRanged = (min: number, max: number) => String.withGuard (function (x): x is string {
    return x.length >= min && x.length < max
})
const SQLSafeStringRanged = (min: number, max: number) => SQLSafeString.withGuard (function (x): x is string {
    return x.length >= min && x.length < max
})
const EnsuringNonEmpty = (min: number = 1) => function <T> (x: T): x is T {
    return Object.keys(x).filter (x => !!x).length >= min
}
const SBoolean = Union (Literal('true'), Literal('false'))

export const FileContent = Record ({
    url: StringRanged (5, 256),
    mimetype: StringRanged (1, 64)
})
.And (
    Partial ({ 
        name: StringRanged (1, 128) 
    })
)

/// CHATS ------------------------

export const DEFAULT_CHAT_PAGE_SIZE = 15

export const ContactGetsOptions = Partial({
    onlyUpdated: Union(SBoolean, Boolean)
})

export const PhoneExistsOptions = Record({
    phone: Union(SNumber, Number)
})
export const ChatGetsOptions = Partial ({
    count: SNumberRanged(1, 1000),
    before: StringRanged(1, 64),
    searchString: String,
    archived: SBoolean,
    unread: SBoolean,
    group: SBoolean,
    assignedToMe: SBoolean,
    tags: Union(
        Array (StringRanged(1, 60)).withGuard (function (x): x is string[] { // tag length is between 16 to 65 chars
            return x.length <= 5
        }),
        StringRanged (1, 60)
    )
})
export const ChatModificationOptions = Record({
    jid: JIDString,
    modification: Union(
        Literal('archive'), 
        Literal('unarchive'), 
        Literal('pin'), 
        Literal('unpin'), 
        Literal('mute'), 
        Literal('unmute')
    )
})
.And (
    Partial ({
        /** duration in seconds for muting */
        durationMs: SNumber
    })
)
export const ChatPictureUpdateOptions = Record ({
    jid: JIDString,
    picture: FileContent
})
export const ChatReadOptions = Record({
    jid: JIDString,
    read: SBoolean
})
export const ChatPresenceSubscription = Record ({
    jid: JIDString
}).And (
    Partial ({
        subscribe: SBoolean
    })
)
export const UserStatusUpdateRequest = Record ({
    status: String
})
export const ChatInfoUpdate = Record ({
    jid: JIDString,
    type: Union(
        Literal('picture'), 
        Literal('about')
    ), 
    content: String
})
export const ChatTypingOptions = Record({
    jid: JIDString
})
.And (
    Partial({ 
        typing: SBoolean 
    })
)

/// MESSAGE FLOWS -----------------

const _DirectMessageOptions = Partial ({
    text: StringRanged (1, 4096),
    location: Record ({
        degreesLongitude: Number,
        degreesLatitude: Number
    }),
    image: FileContent,
    video: FileContent,
    sticker: FileContent,
    audio: FileContent,
    document: FileContent,
    pttAudio: Union(SBoolean, Boolean),
    gifVideo: Union(SBoolean, Boolean)
})
type DMOptionsType = Static<typeof _DirectMessageOptions>
export const DirectMessageOptions = _DirectMessageOptions.withGuard (function (x): x is DMOptionsType {
    const actualKeys = new Set([ "location", "image", "video", "sticker", "audio", "document" ])
    const numKeys = Object.keys(x).filter (x => !!x && actualKeys.has (x)).length 
    return numKeys <= 1  // can't have two kinds of media types
})

export const MessageFlowCreateOptions = Record ({
    name: SQLSafeString,
})
.And (DirectMessageOptions)
.withGuard (EnsuringNonEmpty(2))

export const MessageFlowEditOptions = Record ({
    id: SQLSafeString
}).And(
    Partial ({
        name: SQLSafeString
    })
).And (DirectMessageOptions)
.withGuard (EnsuringNonEmpty(2))

export const MessageFlowGetOptions = Record ({
    flow: SQLSafeString
})
export const MessageFlowGetsOptions = Partial ({
    count: SNumberRanged (1, 500),
    cursor: String,
    search: SQLSafeStringRanged (1, 64)
})

/// MESSAGES ---------------------

export const DEFAULT_MESSAGE_PAGE_SIZE = 20
export const MessageGetsOptions = Record({
    jid: JIDString,
})
.And (
    Partial ({
        before: String,
        count: SNumberRanged(1, 30)
    })
)
export const MessageSearchOptions = Record({
    searchString: StringRanged(1, 1024),
})
.And(
    Partial({
        jid: JIDString,
        count: SNumberRanged(10, 200),
        page: SNumberRanged(0, 10000) 
    })
)
export const MessageGetOptions = Record({
    jid: JIDString,
    messageID: String
})

export const MessageForwardOptions = MessageGetOptions.And(
    Record({
        jids: Union(JIDString, Array(JIDString))
    })
)
export const MessageReschedulingOptions = MessageGetOptions.And (
    Record({
        scheduleAt: Union(SNumber, Number)
    })
)
export const MessageDeleteOptions = MessageGetOptions.And (Partial({ forMe: SBoolean }))

const MessageComposeTemplate = Record ({
    jid: JIDString
}).And (
    Partial ({
        quotedID: String,
        /** UNIX time in seconds */
        scheduleAt: Union(SNumber, Number),
        tag: StringRanged(1, 64),
        withTyping: Union(SBoolean, Boolean)
    })
)

export const MessageComposeOptions = MessageComposeTemplate
    .And (
        DirectMessageOptions
    )
    .withGuard (EnsuringNonEmpty(2))
export const MessageComposeOptionsFlow = MessageComposeTemplate
    .And (MessageFlowGetOptions)
    .And (
        Partial ({
            parameters: Dictionary (String),
            randomizeMessage: Union(SBoolean, Boolean)
        })
    )

/// GROUPS ----------------------------

export const GroupCreateOptions = Record ({
    participants: Array(String),
    subject: String
})
export const GroupRetreivalOptions = Record ({
    jid: JIDString.withGuard (function (x): x is string {
        return x.endsWith('@g.us')
    }),
})
export const GroupSubjectChangeOptions = Record ({
    jid: JIDString,
    subject: String
})
export const GroupModificationOptions = Record ({
    jid: JIDString,
    participants: Array(String),
})

/// NOTES ----------------------------

export const NoteComposeOptions = Record ({
    jid: JIDString,
    text: String,
})
.And (Partial({
    tag: String
}))
export const NoteEditOptions = Record ({ 
    jid: JIDString,
    noteId: SQLSafeString,
    text: String
})
export const NoteDeleteOptions = Record ({ 
    jid: JIDString,
    noteId: SQLSafeString
})

export const ContactUpdatedOptions = Record({
    event: Union(Literal('contacts-update')),
    data: Record({
        phoneNumbers: Array(SNumber),
    }).And(Partial({ 
        assignee: Union(String, Null, Undefined),
        name: Union(String, Null, Undefined),
        addTags: Union(Array(String), Null, Undefined),
        removeTags: Union(Array(String), Null, Undefined)
    }))
})