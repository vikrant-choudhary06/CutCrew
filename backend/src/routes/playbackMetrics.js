const router=require('express').Router();
const media=require('../services/mediaService'),health=require('../services/playbackHealth');
router.post('/metrics',(req,res)=>{
 res.set('Cache-Control','no-store');
 // Telegram-stored playback reports with its stored-media ticket instead of a provider token.
 const storedAsset=req.body.storedTicket?require('../services/storedMediaTicket').verify(req.body.storedTicket):null;
 let ticket;if(!storedAsset){try{ticket=media.verifyToken(req.body.token)}catch{return res.status(403).json({message:'Invalid media session'})}}
 const {sessionId,titleId,event='sample'}=req.body;
 if(!/^[a-f0-9-]{36}$/.test(sessionId||'')||!/^tt\d{5,12}$/.test(titleId||'')||!['sample','ended','failure'].includes(event))return res.status(400).json({message:'Invalid playback sample'});
 const result={source:storedAsset?'cutcrew-storage':health.sourceId(ticket.url),titleId,event};
 for(const [field,max]of Object.entries({playedSeconds:172800,bufferAhead:172800,stalls:10000,stalledSeconds:172800,startupMs:300000,droppedFrames:1e9,totalFrames:1e9})){
  const value=req.body[field];if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max)return res.status(400).json({message:'Invalid playback measurements'});result[field]=Math.round(value*100)/100;
 }
 if(storedAsset)require('../services/storedMetrics').recordPlayback({assetId:storedAsset,...result});
 else health.playback(sessionId,result);
 res.status(202).json({ok:true});
});
module.exports=router;
