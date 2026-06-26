const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const routes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');

// Load env vars
dotenv.config();

const app = express();

const path = require('path');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Root Route to avoid 404 on browser
app.get('/', (req, res) => {
  res.send('<h2>Welcome to the Movie Scraper API!</h2><p>Backend is up and running.</p>');
});

app.get('/admin', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Backend Admin Dashboard</title>
      <style>
        body { font-family: sans-serif; background-color: #121212; color: white; margin: 0; padding: 20px; }
        .container { max-width: 1000px; margin: 0 auto; }
        h1 { color: #4fc1ff; }
        .stats { display: flex; gap: 20px; margin-bottom: 20px; }
        .card { background: #1e1e1e; padding: 20px; border-radius: 8px; flex: 1; border: 1px solid #333; }
        .card h3 { margin: 0 0 10px 0; color: #aaa; font-size: 14px; text-transform: uppercase; }
        .card p { margin: 0; font-size: 32px; font-weight: bold; }
        .terminal { background: #1e1e1e; border-radius: 8px; border: 1px solid #333; overflow: hidden; }
        .terminal-header { background: #323233; padding: 10px; font-family: monospace; color: #ccc; font-size: 12px; }
        .terminal-body { padding: 15px; height: 500px; overflow-y: auto; font-family: 'Consolas', monospace; font-size: 13px; line-height: 1.5; }
        .log-error { color: #f48771; }
        .log-normal { color: #cccccc; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>Admin Dashboard</h1>
        <div class="stats">
          <div class="card">
            <h3>Registered Users</h3>
            <p id="reg-users">Loading...</p>
          </div>
          <div class="card">
            <h3>Live Online Viewers</h3>
            <p id="online-users" style="color: #4ade80;">Loading...</p>
          </div>
        </div>
        <div class="terminal">
          <div class="terminal-header">node server.js — live logs</div>
          <div class="terminal-body" id="term-body">Loading logs...</div>
        </div>
      </div>

      <script>
        async function fetchStats() {
          try {
            const res = await fetch('/api/admin/stats');
            const json = await res.json();
            if (json.status === 'success') {
              document.getElementById('reg-users').innerText = json.data.registeredUsers;
              document.getElementById('online-users').innerText = json.data.onlineUsers;
            }
          } catch(e) {}
        }

        async function fetchLogs() {
          try {
            const res = await fetch('/api/logs');
            const json = await res.json();
            if (json.status === 'success') {
              const body = document.getElementById('term-body');
              body.innerHTML = json.data.map(log => {
                const isErr = log.includes('ERROR:');
                return \`<div class="\${isErr ? 'log-error' : 'log-normal'}">\${log}</div>\`;
              }).join('');
              body.scrollTop = body.scrollHeight;
            }
          } catch(e) {}
        }

        fetchStats();
        fetchLogs();
        setInterval(fetchStats, 5000);
        setInterval(fetchLogs, 2000);
      </script>
    </body>
    </html>
  `);
});

// Routes
app.use('/api', routes);

// Error Handling Middleware
app.use(errorHandler);

module.exports = app;
