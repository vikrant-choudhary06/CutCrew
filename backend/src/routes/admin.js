const express = require('express');
const router = express.Router();
const { User } = require('../models');

// In-memory store for active sessions
// Map of IP/SessionID -> Last active timestamp
const activeUsers = new Map();

// Cleanup stale sessions every 30 seconds
setInterval(() => {
  const now = Date.now();
  for (const [id, lastSeen] of activeUsers.entries()) {
    if (now - lastSeen > 20000) { // 20 seconds inactive = dropped
      activeUsers.delete(id);
    }
  }
}, 30000);

router.post('/heartbeat', (req, res) => {
  // Use IP or a generated session cookie as ID. 
  // For simplicity, we use IP + UserAgent
  const id = req.ip + (req.headers['user-agent'] || '');
  activeUsers.set(id, Date.now());
  
  res.status(200).json({ status: 'success', message: 'Heartbeat received' });
});

router.get('/stats', async (req, res, next) => {
  try {
    const registeredUsers = await User.countDocuments();
    
    // Clean up before returning count just to be accurate
    const now = Date.now();
    let onlineCount = 0;
    for (const lastSeen of activeUsers.values()) {
      if (now - lastSeen <= 20000) {
        onlineCount++;
      }
    }

    res.status(200).json({
      status: 'success',
      data: {
        registeredUsers,
        onlineUsers: onlineCount
      }
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    next(error);
  }
});

module.exports = router;
