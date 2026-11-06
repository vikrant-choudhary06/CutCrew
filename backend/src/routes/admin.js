const express = require('express');
const router = express.Router();
const { User } = require('../models');

router.get('/stats', require('../middlewares/adminAuth'), async (req, res, next) => {
  try {
    const registeredUsers = await User.countDocuments();
    res.status(200).json({
      status: 'success',
      data: {
        registeredUsers
      }
    });
  } catch (error) {
    console.error('Error fetching admin stats:', error);
    next(error);
  }
});

router.get('/health',require('../middlewares/adminAuth'),async(req,res,next)=>{try{const db=require('../config/db');await db.query('SELECT 1');res.json({database:'ready',uptimeSeconds:Math.floor(process.uptime()),activeConversions:require('../services/remuxService').activeConversions(),enabledProviders:require('../utils/providerHelper').getAvailableProvidersLocal(),weeklyProviderCheck:require('../services/providerCheck').latest(),weeklyAnimeCheck:require('../services/providerCheck').latestAnime(),weeklySourceCheck:require('../services/providerCheck').latestSources(),playbackSources:require('../services/streamSources').sourceOrder(),anime:require('../services/animeService').status(),providers:require('../services/providerStatus').snapshot(),playback:require('../services/playbackHealth').snapshot()});}catch(e){next(e);}});
router.get('/catalogue',require('../middlewares/adminAuth'),async(req,res,next)=>{try{const db=require('../config/db');const q=typeof req.query.q==='string'?req.query.q.slice(0,150):'';const rows=await db.query('SELECT imdb_id,title,title_type,release_year,rating,updated_at FROM movies WHERE title ILIKE $1 ORDER BY updated_at DESC LIMIT 50',['%'+q.replace(/[\\%_]/g,'\\$&')+'%']);res.json({data:rows.rows});}catch(e){next(e);}});
router.patch('/catalogue/:id',require('../middlewares/adminAuth'),async(req,res,next)=>{try{const patch={};if(!/^tt\d{5,12}$/.test(req.params.id))return res.status(400).json({message:'Invalid title ID'});for(const [key,value] of Object.entries(req.body)){if(['title','plot'].includes(key)&&typeof value==='string'&&value.trim()&&value.length<10000)patch[key]=value;else if(key==='genres'&&Array.isArray(value)&&value.length<=20&&value.every(x=>typeof x==='string'&&x.length<=100))patch.genres=value;else return res.status(400).json({message:'Only title, plot and genres may be edited'});}if(!Object.keys(patch).length)return res.status(400).json({message:'No changes supplied'});// Kept as admin_overrides too, so automatic metadata refreshes never undo a manual edit.
const row=await require('../models').Movie.findOneAndUpdate({imdb_id:req.params.id},{$set:{...patch,admin_overrides:patch}});if(!row)return res.status(404).json({message:'Title not found'});res.json({ok:true});}catch(e){next(e);}});
module.exports = router;
