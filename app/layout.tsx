import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SNU 거버넌스 위키',
  description: '서울대학교 거버넌스 통합 위키 채팅',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  );
}
