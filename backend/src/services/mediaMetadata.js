const crypto=require('node:crypto');
const entries=new Map();
const key=ticket=>crypto.createHash('sha256').update(JSON.stringify([ticket.url,ticket.headers||{}])).digest('hex');
function get(ticket){const id=key(ticket),entry=entries.get(id);if(!entry||entry.until<Date.now()){entries.delete(id);return null}return entry.data}
function put(ticket,data){const id=key(ticket),old=get(ticket);if(entries.size>=200&&!entries.has(id))entries.delete(entries.keys().next().value);entries.set(id,{data:{...old,...data},until:Date.now()+300000})}
module.exports={get,put};
