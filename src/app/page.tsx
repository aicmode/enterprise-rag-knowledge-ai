import { redirect } from 'next/navigation';

/**
 * Root entry point.
 *
 * There is no marketing page and, in this deployment, no sign-in either: the
 * public URL drops straight into the working demo.
 */
export default function RootPage() {
  redirect('/dashboard');
}
