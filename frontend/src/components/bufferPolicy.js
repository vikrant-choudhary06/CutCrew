export function bufferAhead(video) {
  for(let index=0;index<video.buffered.length;index++)if(video.currentTime>=video.buffered.start(index)-.35&&video.currentTime<video.buffered.end(index))return Math.max(0,video.buffered.end(index)-video.currentTime)
  return 0
}
export function bufferTarget({converted=false,rebuffer=false,remaining=Infinity}) {
  const target=rebuffer?12:converted?8:5
  return Number.isFinite(remaining)?Math.max(0,Math.min(target,remaining-.15)):target
}
export function canResume({ahead,target,elapsedMs,readyState}) {
  return readyState>=2&&(ahead>=target||elapsedMs>=10000&&ahead>=Math.min(2,target))
}
