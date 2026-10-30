import { useState } from 'react'
import { useLibrary } from './LibraryContext'
export default function AccountPanel(){
 const lib=useLibrary(),[mode,setMode]=useState(lib.accountAction?.mode||'login'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState(''),[name,setName]=useState('')
 async function run(work){setBusy(true);setError('');setMessage('');try{await work();return true}catch(e){setError(e.message);return false}finally{setBusy(false)}}
 function changeMode(value){setMode(value);setError('');setMessage('');if(!['reset','verify'].includes(value))lib.setAccountAction(null)}
 async function submit(event){event.preventDefault();const form=event.currentTarget,data=new FormData(form);await run(async()=>{
  if(mode==='forgot'){const body=await lib.api('/forgot-password',{method:'POST',body:JSON.stringify({email:data.get('email')})});setMessage(body.message);return}
  if(mode==='reset'){if(data.get('password')!==data.get('confirmation'))throw new Error('Passwords do not match');const body=await lib.resetPassword(lib.accountAction?.token,data.get('password'));lib.setAccountAction(null);setMode('login');setMessage(body.message);form.reset();return}
  await lib.authenticate(mode,data.get('email'),data.get('password'))
 })}
 if(!lib.ready)return <><h2 id="panel-heading">Preparing your account</h2><p role="status">Checking your session…</p></>
 return <><span className="eyebrow">MAKE IT YOUR OWN</span><h2 id="panel-heading">{mode==='reset'?'Choose a new password':mode==='verify'?'Verify your email':lib.auth?'Your profiles':mode==='forgot'?'Reset your password':'Welcome to CutCrew'}</h2>
 {mode==='verify'?<><p className="status-message">Confirm your email using the link you received.</p><button className="panel-action" disabled={busy} onClick={()=>run(async()=>{const body=await lib.api('/verify-email',{method:'POST',body:JSON.stringify({token:lib.accountAction?.token})});lib.setAccountAction(null);if(lib.auth)await lib.refreshAccount();setMode('login');setMessage(body.message)})}>Verify email</button><button className="text-action" onClick={()=>changeMode('login')}>Back to account</button></>:
 mode==='reset'||!lib.auth?<>
 <p className="status-message">{mode==='forgot'?'Enter your account email to request a reset link.':mode==='reset'?'Use a new password of at least 12 characters. Your existing sessions will be signed out.':'Keep watching across devices, or continue as a guest.'}</p>
 {!['forgot','reset'].includes(mode)&&<div className="type-tabs"><button disabled={busy} aria-pressed={mode==='login'} onClick={()=>changeMode('login')}>Sign in</button><button disabled={busy} aria-pressed={mode==='register'} onClick={()=>changeMode('register')}>Create account</button></div>}
 <form onSubmit={submit}>
 {mode!=='reset'&&<label className="account-field">Email<input name="email" type="email" required maxLength={254} autoComplete="email"/></label>}
 {mode!=='forgot'&&<label className="account-field">{mode==='reset'?'New password':'Password'}<input name="password" type="password" required minLength={12} maxLength={128} autoComplete={mode==='login'?'current-password':'new-password'}/></label>}
 {mode==='reset'&&<label className="account-field">Confirm new password<input name="confirmation" type="password" required minLength={12} maxLength={128} autoComplete="new-password"/></label>}
 <button className="panel-action" disabled={busy}>{busy?'Please wait…':mode==='forgot'?'Send reset link':mode==='reset'?'Update password':mode==='login'?'Sign in':'Create account'}</button></form>
 {mode==='login'&&<button className="text-action" disabled={busy} onClick={()=>changeMode('forgot')}>Forgot password?</button>}
 {['forgot','reset'].includes(mode)&&<button className="text-action" disabled={busy} onClick={()=>changeMode('login')}>Back to sign in</button>}
 </>:<>
 <p className="status-message">{lib.auth.user.email} · {lib.auth.user.emailVerified?'Email verified':'Email not verified'}</p>
 {!lib.auth.user.emailVerified&&<button className="panel-action" disabled={busy} onClick={()=>run(async()=>{setMessage((await lib.api('/send-verification',{method:'POST',body:'{}'})).message)})}>Send verification email</button>}
 <label className="account-field">Active profile<select disabled={busy} value={lib.profile} onChange={e=>lib.changeProfile(e.target.value)}>{lib.auth.profiles.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
 {lib.auth.profiles.length<5&&<form onSubmit={async e=>{e.preventDefault();if(await run(()=>lib.createProfile(name)))setName('')}}><label className="account-field">New profile<input required maxLength={40} value={name} onChange={e=>setName(e.target.value)} placeholder="Profile name"/></label><button className="panel-action" disabled={busy}>Create profile</button></form>}
 <div className="account-actions"><button className="panel-action" disabled={busy} onClick={()=>run(async()=>{await lib.importDevice();setMessage('Device library imported.')})}>Import this device’s library</button><button className="panel-action" disabled={busy} onClick={()=>run(lib.logout)}>Sign out</button></div><p className="status-message">Each profile has its own watchlist and viewing progress.</p>
 </>}
 {message&&<p className="account-feedback" role="status">{message}</p>}{error&&<p className="account-feedback account-error" role="alert">{error}</p>}</>
}
