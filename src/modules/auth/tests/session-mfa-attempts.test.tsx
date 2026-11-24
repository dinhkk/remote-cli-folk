import '@/modules/i18n';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { AuthProvider } from '@/modules/auth/context/AuthContext';
import ProtectedRoute from '@/modules/auth/ProtectedRoute';
import { requestMfaReauth, expireAuthSession } from '@/shared/authToken';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear(); });

it.each(['unlock', 'mfa/reauth'])('TH-08: %s shows remaining attempts then returns to login with the revocation reason', async route => {
 let calls=0;
 vi.stubGlobal('fetch',vi.fn(async (url: string) => {
  let status=200,body:unknown={},headers:Record<string,string>={};
  if(url==='/api/auth/status') body={needsSetup:false};
  if(url==='/api/auth/session-status')body={locked:route==='unlock'};
  if(url==='/api/auth/user'){status=route==='unlock'?423:200;body=route==='unlock'?{code:'AUTH_SESSION_LOCKED'}:{user:{id:1,username:'synthetic'}};}
  if(url==='/api/user/onboarding-status')body={hasCompletedOnboarding:true};
  if(url==='/api/auth/'+route) {
   calls++;status=calls===1?403:401;
   body={error:{code:calls===1?'MFA_CODE_INVALID':'MFA_SESSION_REVOKED',message:'Synthetic',details:{attemptsRemaining:calls===1?4:0}}};
   if(calls===2)headers={'X-Auth-Error':'mfa-attempts-exceeded'};
  }
  return new Response(JSON.stringify(body),{status,headers});
 }));
 render(<AuthProvider><ProtectedRoute><button onClick={()=>{void requestMfaReauth();}}>Sensitive action</button></ProtectedRoute></AuthProvider>);
 if(route==='mfa/reauth')fireEvent.click(await screen.findByText('Sensitive action'));
 const input=await screen.findByLabelText('Authenticator code');
 fireEvent.change(input,{target:{value:'000000'}});fireEvent.submit(input.closest('form')!);
 await screen.findByText('Incorrect code. Attempts remaining: 4.');
 fireEvent.change(input,{target:{value:'000000'}});fireEvent.submit(input.closest('form')!);
 await screen.findByRole('button',{name:'Sign In'});
 expect(screen.getByText('This session ended after 5 incorrect authenticator codes. Sign in again.')).toBeTruthy();
 expect(screen.queryByRole('dialog')).toBeNull();
 expect(screen.queryByText('Sensitive action')).toBeNull();
 // A concurrent generic expiry must not hide the meaningful reason.
 expireAuthSession();
 await waitFor(()=>expect(screen.getByText('This session ended after 5 incorrect authenticator codes. Sign in again.')).toBeTruthy());
});
