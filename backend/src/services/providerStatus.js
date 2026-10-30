const records=new Map();
function record(provider,ok,duration){const old=records.get(provider)||{attempts:0,successes:0,failures:0};records.set(provider,{attempts:old.attempts+1,successes:old.successes+(ok?1:0),failures:old.failures+(ok?0:1),lastOutcome:ok?'sources-resolved':'no-source-or-error',lastChecked:new Date().toISOString(),durationMs:duration});}
module.exports={record,snapshot:()=>Object.fromEntries(records)};
