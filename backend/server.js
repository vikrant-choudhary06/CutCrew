const app = require('./src/app');
const connectDB = require('./src/config/db');
const startCronJobs = require('./src/cron/cronJobs');
const fs = require('fs');
const path = require('path');

// Setup file logging for /logs route
const logFile = path.join(__dirname, 'server.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

const formatLog = (msg) => {
  return `[${new Date().toISOString()}] ${msg}\n`;
};

const originalLog = console.log;
const originalError = console.error;

console.log = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  logStream.write(formatLog(`LOG: ${msg}`));
  originalLog.apply(console, args);
};

console.error = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  logStream.write(formatLog(`ERROR: ${msg}`));
  originalError.apply(console, args);
};

const PORT = process.env.PORT || 5000;

// Connect to Database
connectDB();

// Initialize Cron Jobs
startCronJobs();

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
