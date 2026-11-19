import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = { title: 'OpenToken', description: '模型接入和用量核对控制台' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
