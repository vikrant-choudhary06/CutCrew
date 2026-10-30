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
}, 30000).unref();

router.post('/heartbeat', (req, res) => {
  // Use IP or a generated session cookie as ID. 
  // For simplicity, we use IP + UserAgent
  const id = req.ip + (req.headers['user-agent'] || '');
  activeUsers.set(id, Date.now());
  
  res.status(200).json({ status: 'success', message: 'Heartbeat received' });
});

router.get('/stats', require('../middlewares/adminAuth'), async (req, res, next) => {
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

router.get('/health',require('../middlewares/adminAuth'),async(req,res,next)=>{try{const db=require('../config/db');await db.query('SELECT 1');res.json({database:'ready',uptimeSeconds:Math.floor(process.uptime()),activeConversions:require('../services/remuxService').activeConversions(),enabledProviders:require('../utils/providerHelper').getAvailableProvidersLocal(),providers:require('../services/providerStatus').snapshot(),playback:require('../services/playbackHealth').snapshot()});}catch(e){next(e);}});
router.get('/catalogue',require('../middlewares/adminAuth'),async(req,res,next)=>{try{const db=require('../config/db');const q=typeof req.query.q==='string'?req.query.q.slice(0,150):'';const rows=await db.query('SELECT imdb_id,title,title_type,release_year,rating,updated_at FROM movies WHERE title ILIKE $1 ORDER BY updated_at DESC LIMIT 50',['%'+q.replace(/[\\%_]/g,'\\$&')+'%']);res.json({data:rows.rows});}catch(e){next(e);}});
router.patch('/catalogue/:id',require('../middlewares/adminAuth'),async(req,res,next)=>{try{const patch={};if(!/^tt\d{5,12}$/.test(req.params.id))return res.status(400).json({message:'Invalid title ID'});for(const [key,value] of Object.entries(req.body)){if(['title','plot'].includes(key)&&typeof value==='string'&&value.trim()&&value.length<10000)patch[key]=value;else if(key==='genres'&&Array.isArray(value)&&value.length<=20&&value.every(x=>typeof x==='string'&&x.length<=100))patch.genres=value;else return res.status(400).json({message:'Only title, plot and genres may be edited'});}if(!Object.keys(patch).length)return res.status(400).json({message:'No changes supplied'});// Kept as admin_overrides too, so automatic metadata refreshes never undo a manual edit.
const row=await require('../models').Movie.findOneAndUpdate({imdb_id:req.params.id},{$set:{...patch,admin_overrides:patch}});if(!row)return res.status(404).json({message:'Title not found'});res.json({ok:true});}catch(e){next(e);}});
module.exports = router;
