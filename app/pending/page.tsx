import { auth } from '@/lib/auth/config';
import { redirect } from 'next/navigation';
import { canChat } from '@/lib/auth/roles';
import PendingActions from './pending-actions';

export default async function PendingPage() {
  const session = await auth();
  if (!session) redirect('/login');
  if (canChat(session.user.role)) redirect('/');

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="text-center max-w-md mx-auto p-8 bg-white rounded-2xl shadow-sm border border-gray-100">
        <div className="w-16 h-16 bg-yellow-100 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <h1 className="text-xl font-semibold text-gray-900 mb-2">승인 대기 중</h1>
        <p className="text-gray-500 text-sm leading-relaxed">
          가입 신청이 완료되었습니다.<br />
          관리자가 계정을 승인하면 서비스를 이용할 수 있습니다.
        </p>
        <PendingActions />
      </div>
    </div>
  );
}
