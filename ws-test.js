const WebSocket = require('ws');

const CHATROOM_ID = process.argv[2] ? parseInt(process.argv[2]) : 3148916;
const channel = `chatrooms.${CHATROOM_ID}.v2`;
const wsUrl = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false';

console.log(`Connecting to chatroom ${CHATROOM_ID}...`);
const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { auth: '', channel } }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());
  if (msg.event?.startsWith('pusher')) return; // skip ping/pong noise

  if (msg.event === 'App\\Events\\ChatMessageEvent') {
    const d = JSON.parse(msg.data);
    const badges = (d.sender?.identity?.badges || []).map(b => b.type).join(',');
    console.log(`CHAT [${badges || 'no-badge'}] ${d.sender?.username} (id:${d.sender?.id}): ${d.content}`);
  } else {
    // Log ALL other events in full so we can see if your messages arrive as something else
    const raw = typeof msg.data === 'string' ? msg.data : JSON.stringify(msg.data);
    console.log(`EVENT: ${msg.event} | ${raw.slice(0, 300)}`);
  }
});

ws.on('close', () => console.log('Disconnected.'));
ws.on('error', (e) => console.error('Error:', e.message));

console.log('Listening for 90s. Send a message in your channel now!\n');
setTimeout(() => { ws.close(); process.exit(0); }, 90000);
