import NDK, { NDKEvent, NDKPrivateKeySigner, type NDKRelay, type NostrEvent } from '@nostr-dev-kit/ndk';
import chalk from 'chalk';
import * as chrono from 'chrono-node';
import { format, fromUnixTime, getUnixTime } from 'date-fns';
import * as dotenv from 'dotenv';

const log = console.log;
const debug = chalk.bold.gray;
const info = chalk.bold.white;
const error = chalk.bold.red;
const debugLog = (...args: string[]) => log(debug(...args));
const infoLog = (...args: string[]) => log(info(...args));
const errorLog = (...args: string[]) => log(error(...args));

let kv: Deno.Kv;
let ndk: NDK;

interface UserData {
  timezone: string;
}
class UserData implements UserData {
  constructor() {
    this.timezone = 'UTC';
  }
}

interface Reminder {
  remind_at: number;
  event: NostrEvent;
  comment: string | undefined;
}

type ReminderList = Array<Reminder>;

const currUnixtime = (): number => getUnixTime(new Date());

const getEnv = (key: string) => {
  const value = Deno.env.get(key);
  if ((value === undefined) || (value === null)) {
    throw (`missing env var for ${key}`);
  }
  return value;
};

const convertTZ = (date: Date, tzString: string): Date => {
  return new Date(date.toLocaleString('sv-SE', { timeZone: tzString }));
};

const formatTZ = (date: Date, fmtString: string, tzString: string): string => {
  return format(convertTZ(date, tzString), fmtString);
};

const isValidTZ = (tzString: string): boolean => {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tzString });
    return true;
  } catch (_) {
    return false;
  }
};

const getUserData = async (id: string): Promise<UserData | null> => {
  const primaryKey = ['users', id];

  const res = await kv.get<UserData>(primaryKey);
  return res.value;
};

const upsertUserData = async (id: string, userData: UserData): Promise<void> => {
  const primaryKey = ['users', id];

  await kv.atomic()
    .set(primaryKey, userData)
    .commit();
};

const insertReminder = async (reminder: Reminder): Promise<void> => {
  if (reminder.event.id == undefined) {
    throw new Error('Event id not found.');
  }
  const primaryKey = ['reminder', reminder.remind_at, reminder.event.id];
  const byUserKey = ['reminder_by_user', reminder.event.pubkey, reminder.event.id];
  const res = await kv.atomic()
    .check({ key: primaryKey, versionstamp: null })
    .check({ key: byUserKey, versionstamp: null })
    .set(primaryKey, reminder)
    .set(byUserKey, reminder)
    .commit();
  if (!res.ok) {
    throw new TypeError('Reminder with ID already exists');
  }
};

const listReminderByUser = async (id: string): Promise<ReminderList> => {
  const reminderList: ReminderList = [];

  const key = ['reminder_by_user', id];
  const entries = kv.list<Reminder>({ prefix: key });
  for await (const entry of entries) {
    reminderList.push(entry.value);
  }
  return reminderList;
};

const listReminder = async (endDate: Date): Promise<ReminderList> => {
  const reminderList: ReminderList = [];

  const prefix = ['reminder'];
  const key = [...prefix, getUnixTime(endDate)];
  const entries = kv.list<Reminder>({ prefix, end: key });
  for await (const entry of entries) {
    reminderList.push(entry.value);
  }
  return reminderList;
};

const deleteReminder = async (reminder: Reminder): Promise<void> => {
  if (reminder.event.id == undefined) {
    throw new Error('Event id not found.');
  }

  let res = { ok: false };
  while (!res.ok) {
    const primaryKey = ['reminder', reminder.remind_at, reminder.event.id];
    const byUserKey = ['reminder_by_user', reminder.event.pubkey, reminder.event.id];

    const getRes = await kv.get<Reminder>(primaryKey);
    if (getRes.value === null) return;
    res = await kv.atomic()
      .check(getRes)
      .delete(primaryKey)
      .delete(byUserKey)
      .commit();
  }
};

const createReplyTemplate = (event: NostrEvent): NDKEvent => {
  if (event.id == undefined) {
    throw new Error('Event id not found.');
  }
  const referenceEvent = new NDKEvent(ndk);
  referenceEvent.id = event.id;
  referenceEvent.kind = event.kind;
  referenceEvent.pubkey = event.pubkey;

  const replyEvent = new NDKEvent(ndk);
  replyEvent.kind = event.kind;
  replyEvent.tag(referenceEvent);
  return replyEvent;
};

const listCommandRegex = /^LIST\b/i;
const deleteCommandRegex = /^DELETE\b/i;
const commandRegex = /^!remindme\b/i;
const commentRegex = /"(.*)"/i;

const tzCommandRegex = /^TZ\b/i;

(async (_) => {
  dotenv.loadSync({ export: true });

  const COOL_TIME_DUR_SEC: number = parseInt(Deno.env.get('COOL_TIME_DUR_SEC') || '60', 10);
  const KV_LOCATION: string = Deno.env.get('KV_LOCATION') || ':memory:';
  const BOT_PRIVKEY: string = getEnv('BOT_PRIVKEY');

  kv = await Deno.openKv(KV_LOCATION);

  const explicitRelayUrls = [
    'wss://nos.lol/',
    'wss://nostr-relay.nokotaro.com/',
    'wss://offchain.pub/',
    'wss://r.kojira.io/',
    'wss://relay.damus.io/',
    'wss://relay.nostr.wirednet.jp/',
    'wss://relayable.org/',
    'wss://yabu.me/',
  ];

  const signer = new NDKPrivateKeySigner(BOT_PRIVKEY);
  const BOT_PUBKEY = (await signer.user()).pubkey;

  ndk = new NDK({
    explicitRelayUrls,
    signer,
  });
  ndk.pool.on('relay:connect', (r: NDKRelay) => {
    infoLog(`Connected to relay ${r.url}`);
  });

  await ndk.connect(2000);

  const sub = ndk.subscribe({ kinds: [1], since: currUnixtime() });
  sub.on('event', async (event: NDKEvent) => {
    if (
      event.id == undefined || event.created_at == undefined || !commandRegex.test(event.content) ||
      event.pubkey === BOT_PUBKEY ||
      event.created_at < currUnixtime() - COOL_TIME_DUR_SEC
    ) {
      return;
    }

    infoLog(`received event on a ${event.id}: ${event.content}`);

    const content = event.content.replace(commandRegex, '').trim();
    infoLog(`=> ${content}`);

    const commentPos = content.indexOf('"');
    let command: string | undefined;
    let comment: string | undefined;
    if (commentPos !== -1) {
      comment = content.substring(commentPos).match(commentRegex)?.[1]?.trim();
      command = content.substring(0, commentPos).trim();
    } else {
      command = content.trim();
    }
    infoLog(`command: ${command}`);
    infoLog(`comment: ${comment}`);

    const userData = await getUserData(event.pubkey) || new UserData();

    if (tzCommandRegex.test(command)) {
      // Set TZ
      debugLog('Set TZ');
      const timezone = command.replace(tzCommandRegex, '').trim();
      if (isValidTZ(timezone)) {
        debugLog(`valid TZ: ${timezone}`);
        userData.timezone = timezone;
        await upsertUserData(event.pubkey, userData);

        const reply = createReplyTemplate(event.rawEvent());
        reply.content = `Timezone set to ${timezone}`;
        reply.created_at = event.created_at + 1;
        await reply.publish();
      } else {
        debugLog(`invalid TZ: ${timezone}`);
        const reply = createReplyTemplate(event.rawEvent());
        reply.content = `Provided timezone invalid.`;
        reply.created_at = event.created_at + 1;
        await reply.publish();
      }
    } else if (listCommandRegex.test(command)) {
      //TODO: List reminder
      debugLog('List reminder');
      const reminderList = await listReminderByUser(event.pubkey);
    } else if (deleteCommandRegex.test(command)) {
      //TODO: Delete reminder
      debugLog('Delete reminder');
    } else {
      // Add reminder
      debugLog('Add reminder');
      const timezone = userData.timezone;
      const reminderDate = chrono.parseDate(command, { instant: new Date(), timezone }, { forwardDate: true }) ??
        chrono.parseDate(`next ${command}`, { instant: new Date(), timezone }, { forwardDate: true }) ??
        fromUnixTime(0);
      infoLog(reminderDate.toString());

      if (reminderDate > new Date()) {
        const reminder: Reminder = {
          remind_at: getUnixTime(reminderDate),
          event: event.rawEvent(),
          comment,
        };

        await insertReminder(reminder);

        const reply = createReplyTemplate(event.rawEvent());
        reply.content = `I will remind at ${formatTZ(reminderDate, 'yyyy-MM-dd HH:mm', timezone)} (${timezone})`;
        reply.created_at = event.created_at + 1;
        await reply.publish();
      }
    }
  });

  Deno.cron('Send reminder', '* * * * *', async () => {
    debugLog('This will run every 1 minutes');
    const reminderList = await listReminder(new Date());

    const current = currUnixtime();
    await Promise.all(
      reminderList.filter((record) => record.remind_at <= current)
        .map(async (record) => {
          debugLog(`Send reminder to ${record.event.id}`);
          const reply = createReplyTemplate(record.event);
          reply.created_at = record.remind_at;

          reply.content = `((🔔))`;
          if (record.comment !== undefined && record.comment.length !== 0) {
            reply.content += ' ' + record.comment;
          }
          await reply.publish();
          debugLog(`Successfully sent with ${reply.id}`);
          await deleteReminder(record);
        }),
    );
  });
})().catch((e) => errorLog(e));
