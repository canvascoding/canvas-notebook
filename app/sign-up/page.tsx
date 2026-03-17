import { redirect } from 'next/navigation';
import SignUpForm from './sign-up-form';

export default function SignUpPage() {
  const allowSignUp = process.env.ONBOARDING === 'true';

  if (!allowSignUp) {
    redirect('/login');
  }

  return <SignUpForm />;
}
