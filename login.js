(() => {
  'use strict';
  const form=document.querySelector('#login-form');
  const email=document.querySelector('#email');
  const password=document.querySelector('#password');
  const toggle=document.querySelector('#password-toggle');
  const submit=document.querySelector('#login-submit');
  const label=document.querySelector('#submit-label');
  const error=document.querySelector('#login-error');
  const status=document.querySelector('#login-status');
  let pending=false;

  function localPath(value){
    if(typeof value!=='string'||!value.startsWith('/')||value.startsWith('//')||/[\\\u0000-\u0020\u007f]/.test(value))return '/';
    try{const target=new URL(value,location.origin);return target.origin===location.origin?target.pathname+target.search:'/';}catch{return '/';}
  }
  function clearError(){
    error.hidden=true;error.textContent='';email.removeAttribute('aria-invalid');password.removeAttribute('aria-invalid');
  }
  toggle.addEventListener('click',()=>{
    const visible=password.type==='password';
    password.type=visible?'text':'password';
    toggle.setAttribute('aria-pressed',String(visible));
    toggle.setAttribute('aria-label',visible?'Hide password':'Show password');
  });
  email.addEventListener('input',clearError);
  password.addEventListener('input',clearError);
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    if(pending)return;
    pending=true;clearError();submit.disabled=true;form.setAttribute('aria-busy','true');label.textContent='Signing in…';status.textContent='Signing in. Please wait.';
    let completed=false;
    try{
      const response=await fetch('/api/auth/login',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({email:email.value.trim(),password:password.value,returnTo:localPath(new URLSearchParams(location.search).get('returnTo')||'/')}),
        signal:AbortSignal.timeout(15000)
      });
      const result=await response.json().catch(()=>null);
      if(!response.ok){
        if(response.status===401){email.setAttribute('aria-invalid','true');password.setAttribute('aria-invalid','true');}
        const message=response.status===401?'Email or password is incorrect. Check your details and try again.':result?.error?.message;
        throw new Error(typeof message==='string'?message:'Unable to sign in right now. Please try again.');
      }
      if(!result||typeof result.returnTo!=='string')throw new Error('Unable to complete sign-in. Please try again.');
      password.value='';status.textContent='Signed in. Opening your workspace.';label.textContent='Opening workspace…';
      completed=true;location.assign(localPath(result.returnTo));
    }catch(failure){
      error.textContent=failure.name==='TimeoutError'||failure.name==='AbortError'?'Sign-in took too long. Please try again.':failure instanceof TypeError?'Unable to reach sign-in. Check your connection and try again.':failure.message||'Unable to sign in. Please try again.';
      error.hidden=false;status.textContent='';
    }finally{
      if(!completed){pending=false;submit.disabled=false;form.setAttribute('aria-busy','false');label.textContent='Sign in';}
    }
  });
})();
