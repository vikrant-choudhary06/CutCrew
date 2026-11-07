const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

// Load env vars before loading routes which might require them
dotenv.config();

const routes = require('./routes');
const errorHandler = require('./middlewares/errorHandler');

const app = express();
// Requests come through Nginx (and the website's container): take the
// visitor's address from X-Forwarded-For, trusting only local proxies.
app.set('trust proxy', 'loopback, linklocal, uniquelocal');

const path = require('path');

// Middleware
const frontendOrigins = (process.env.FRONTEND_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim());
app.use(cors({ credentials: true, origin: (origin, callback) => callback(null, !origin || frontendOrigins.includes(origin)) }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '../public')));

// Root Route to avoid 404 on browser
app.get('/', (req, res) => {
  res.send('<h2>Welcome to the Movie Scraper API!</h2><p>Backend is up and running.</p>');
});

// Routes
app.use('/api', require('./services/liveActivity').track);
app.use('/api', routes);

// Error Handling Middleware
app.use(errorHandler);

module.exports = app;
