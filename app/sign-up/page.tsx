import { redirect } from 'next/navigation';
import SignUpForm from './sign-up-form';

export default function SignUpPage() {
  const allowSignUp = process.env.ALLOW_SIGNUP === 'true';

  if (!allowSignUp) {
    redirect('/login');
  }

  return <SignUpForm />;
}
