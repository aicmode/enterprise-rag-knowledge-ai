import { FileText, LayoutDashboard, MessageSquareText, History } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  description: string;
}

/** Single source of truth for navigation, shared by the sidebar and mobile drawer. */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: '/dashboard',
    label: 'ダッシュボード',
    icon: LayoutDashboard,
    description: '登録状況と利用状況の概要',
  },
  { href: '/documents', label: '資料', icon: FileText, description: 'PDFの登録と解析状態' },
  { href: '/ask', label: 'AIに質問', icon: MessageSquareText, description: '根拠付きで社内資料を検索' },
  { href: '/history', label: '質問履歴', icon: History, description: '過去の質問と回答' },
] as const;
