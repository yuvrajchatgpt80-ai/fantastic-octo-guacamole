const { WebSocketServer } = require('ws');

// Allow port to be configured via environment
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8765;

// Server
const wss = new WebSocketServer({ port: PORT });

// Track clients
const senders = new Map(); // ws -> { id, addr }
const browserClients = new Set();

console.log(`✅ WebSocket server started on ws://localhost:${PORT}`);

// --- Buffers with timestamp ---
let screenshotBuffer = []; // { data, senderId, timestamp }
let codeBuffer = [];       // { data, timestamp }
const MAX_BUFFER_SIZE = 100;
const MESSAGE_TTL_MS = 3 * 60 * 60 * 1000; // 3 hours

// --- Clean expired messages every 10 minutes ---
function cleanExpiredBuffers() {
  const now = Date.now();
  screenshotBuffer = screenshotBuffer.filter(msg => now - msg.timestamp < MESSAGE_TTL_MS);
  codeBuffer = codeBuffer.filter(msg => now - msg.timestamp < MESSAGE_TTL_MS);
}
setInterval(cleanExpiredBuffers, 10 * 60 * 1000);

// --- Keepalive logic ---
function heartbeat() { this.isAlive = true; }
const interval = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// --- Connection Handling ---
wss.on('connection', (ws) => {
  console.log('🔌 A client connected.');
  ws.isAlive = true;
  ws.on('pong', heartbeat);
  ws._isBrowser = false;

  const registerTimer = setTimeout(() => {
    try {
      if (!ws._isBrowser && !senders.has(ws)) {
        const addr = (ws._socket && (ws._socket.remoteAddress || ws._socket.remotePort))
          ? `${ws._socket.remoteAddress || 'unknown'}:${ws._socket.remotePort || '0'}`
          : 'unknown';
        const id = `sender-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        senders.set(ws, { id, addr });

        console.log(`📡 Sender auto-registered: ${id} @ ${addr}`);
        broadcastToBrowsers({ type: 'sender_connected', data: { id, addr } });

        // Flush buffered code to this sender
        codeBuffer.forEach(msg => {
          try { 
            if (ws.readyState === 1) { // 1 = WebSocket.OPEN
              ws.send(JSON.stringify({ type: 'code', data: msg.data }));
            }
          } 
          catch(e) { console.error('Error flushing code buffer:', e); }
        });
        codeBuffer = [];
      }
    } catch(e) {
      console.error('Error auto-registering sender:', e);
    }
  }, 800);

  ws._registerTimer = registerTimer;

  function broadcastToBrowsers(payload) {
    const str = JSON.stringify(payload);
    browserClients.forEach(client => {
      try { 
        if (client.readyState === 1) { // 1 = WebSocket.OPEN
          client.send(str);
        }
      }
      catch(e) { console.error('Error sending to browser client:', e); }
    });
  }

  // --- Message Handling ---
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      // Sender → Screenshot
      if (data.type === 'screenshot') {
        if (!senders.has(ws)) {
          const addr = (ws._socket && (ws._socket.remoteAddress || ws._socket.remotePort))
            ? `${ws._socket.remoteAddress || 'unknown'}:${ws._socket.remotePort || '0'}`
            : 'unknown';
          const id = `sender-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          senders.set(ws, { id, addr });
          console.log(`📡 Sender registered: ${id} @ ${addr}`);
          broadcastToBrowsers({ type: 'sender_connected', data: { id, addr } });
        }

        const senderInfo = senders.get(ws);
        const forward = {
          type: 'screenshot',
          data: data.data,
          senderId: senderInfo?.id,
        };

        if (browserClients.size > 0) {
          broadcastToBrowsers(forward);
          console.log(`🖼️ Screenshot forwarded to ${browserClients.size} browser(s)`);
        } else {
          if (screenshotBuffer.length >= MAX_BUFFER_SIZE) screenshotBuffer.shift();
          screenshotBuffer.push({ ...forward, timestamp: Date.now() });
          console.log(`🖼️ Stored screenshot. Buffer size: ${screenshotBuffer.length}`);
        }
      }

      // Browser → Code
      else if (data.type === 'code') {
        console.log('💻 Code received from browser client.');
        if (senders.size > 0) {
          let sentCount = 0;
          senders.forEach((info, s) => {
            try { 
              if (s !== ws && s.readyState === 1) { // 1 = WebSocket.OPEN
                s.send(message.toString());
                sentCount++;
              }
            }
            catch(e) { console.error('Error sending code to sender:', e); }
          });
          console.log(`✅ Code forwarded to ${sentCount} sender(s).`);
        } else {
          if (codeBuffer.length >= MAX_BUFFER_SIZE) codeBuffer.shift();
          codeBuffer.push({ data: data.data, timestamp: Date.now() });
          console.log(`📦 Stored code. Buffer size: ${codeBuffer.length}`);
          try { 
            if (ws.readyState === 1) { // 1 = WebSocket.OPEN
              ws.send(JSON.stringify({ type: 'no_senders', data: 'No sender clients connected' }));
            }
          } catch(e) { console.error('Error notifying browser:', e); }
        }
      }

      // Browser → Register as UI client
      else if (data.type === 'register_browser') {
        ws._isBrowser = true;
        if (ws._registerTimer) { 
          clearTimeout(ws._registerTimer); 
          ws._registerTimer = null; 
        }

        browserClients.add(ws);
        console.log('🖥️  Browser client registered.');

        // Clean up if was mistakenly registered as sender
        if (senders.has(ws)) {
          const info = senders.get(ws);
          senders.delete(ws);
          console.log(`ℹ️ Removed accidental sender registration: ${info.id}`);
          broadcastToBrowsers({ type: 'sender_disconnected', data: { id: info.id, addr: info.addr } });
        }

        // Send current senders list
        const current = Array.from(senders.values());
        try {
          if (ws.readyState === 1) { // 1 = WebSocket.OPEN
            ws.send(JSON.stringify({ type: 'current_senders', data: current }));
            console.log(`📋 Sent current_senders list (${current.length} senders)`);

            // Send buffered screenshots with delay to ensure client is ready
            if (screenshotBuffer.length > 0) {
              console.log(`📤 Preparing to send ${screenshotBuffer.length} buffered screenshots`);
              
              // Use setTimeout to ensure the browser has processed the current_senders message
              setTimeout(() => {
                // Create a copy of the buffer to send
                const toSend = [...screenshotBuffer];
                let sentCount = 0;
                
                toSend.forEach((msg, index) => {
                  // Stagger the sends slightly to avoid overwhelming the client
                  setTimeout(() => {
                    try {
                      if (ws.readyState === 1) { // 1 = WebSocket.OPEN
                        ws.send(JSON.stringify(msg));
                        sentCount++;
                        console.log(`📸 Sent buffered screenshot ${sentCount}/${toSend.length}`);
                      }
                    } catch(e) {
                      console.error(`Error sending buffered screenshot ${index}:`, e);
                    }
                  }, index * 50); // 50ms delay between each message
                });
                
                // Clear the buffer after sending (with delay to ensure all sends are initiated)
                setTimeout(() => {
                  screenshotBuffer = [];
                  console.log(`✅ Cleared screenshot buffer after sending ${sentCount} messages`);
                }, toSend.length * 50 + 100);
              }, 200); // Initial 200ms delay to ensure browser is ready
            }
          }
        } catch(e) {
          console.error('Error sending current_senders or buffered screenshots:', e);
        }
      }
    } catch(e) { 
      console.error('Error processing message:', e); 
    }
  });

  // --- Close Handling ---
  ws.on('close', () => {
    console.log('🔌 A client disconnected.');
    if (ws._registerTimer) { 
      clearTimeout(ws._registerTimer); 
      ws._registerTimer = null; 
    }
    if (senders.has(ws)) {
      const info = senders.get(ws);
      senders.delete(ws);
      console.log(`📴 Sender disconnected: ${info.id}`);
      broadcastToBrowsers({ type: 'sender_disconnected', data: { id: info.id, addr: info.addr } });
    }
    if (browserClients.has(ws)) {
      browserClients.delete(ws);
      console.log(`🖥️ Browser client disconnected. Remaining browsers: ${browserClients.size}`);
    }
  });

  ws.on('error', (error) => console.error('WebSocket error:', error));
});

// Clean up interval on server close
wss.on('close', () => clearInterval(interval));

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Received SIGINT, closing server gracefully...');
  wss.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
