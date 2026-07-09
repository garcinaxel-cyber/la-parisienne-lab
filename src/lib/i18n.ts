'use client';
import { createContext, useContext, useState, useCallback } from 'react';

export type Lang = 'en' | 'vi';

const T = {
  en: {
    // Nav
    dashboard: 'Dashboard', import: 'Import Orders', orders: 'Production Orders', analytics: 'Analytics',
    admin: 'Admin', users: 'Users', logout: 'Log out', labProducts: 'Lab Products', qr_codes: 'QR Codes', settings: 'Settings', excluded: 'Non-production',
    // Teams
    team_baby_mama: 'Team Baby Mama', team_hung: 'Team Hung',
    team_entremet: 'Team Entremet', team_baker: 'Team Baker',
    // Status
    pending: 'To produce', in_progress: 'In progress', done: 'Done',
    skip: 'In stock', partial: 'Partial', blocked: 'Blocked',
    // Import
    importTitle: 'Import Odoo Orders',
    dropHint: 'Drop Sales Order or Stock Replenishment Excel files here',
    browseFiles: 'Browse files',
    importBtn: 'Import & consolidate',
    importing: 'Importing…',
    shippedFromLab: 'Ships directly from lab',
    notes: 'Notes',
    // Orders
    ordersTitle: 'Production Orders',
    mainOrder: 'Main Order', urgentOrder: 'Urgent Order',
    delivery: 'Delivery', publishBtn: 'Publish to teams',
    published: 'Published', draft: 'Draft', cancelled: 'Cancelled',
    // Assignment
    totalQty: 'Total', toProduce: 'To produce', produced: 'Produced',
    exceptionReason: 'Reason', saveException: 'Save',
    // Dashboard
    today: 'Today', pending_label: 'To produce',
    // Users
    usersTitle: 'User Management', role: 'Role', team: 'Team',
    addUser: 'Add user', saveUser: 'Save',
    // Station
    myStation: 'My Station', markDone: 'Done', markProgress: 'In progress',
    orderMain: 'Main Order', orderUrgent: '🚨 Urgent',
    fromLab: '⚡ Ships from lab',
    // Fiches
    fiches: 'Recipe Cards', fichesTitle: 'Production Recipe Cards',
    ficheStep: 'Step', ficheAddStep: 'Add step', ficheSave: 'Save fiche',
    ficheDuration: 'Duration (min)', ficheTemp: 'Temperature (°C)',
    ficheDesc: 'Instructions', ficheNoSteps: 'No steps yet',
    ficheViewBtn: 'View recipe',
    // General
    save: 'Save', cancel: 'Cancel', confirm: 'Confirm',
    noData: 'No data', loading: 'Loading…', error: 'An error occurred',
    search: 'Search', selectDate: 'Select date',
  },
  vi: {
    // Nav
    dashboard: 'Tổng quan', import: 'Nhập đơn hàng', orders: 'Đơn sản xuất', analytics: 'Phân tích',
    admin: 'Quản trị', users: 'Người dùng', logout: 'Đăng xuất', labProducts: 'Sản phẩm Lab', qr_codes: 'Mã QR', settings: 'Cài đặt', excluded: 'Không sản xuất',
    // Teams
    team_baby_mama: 'Team Baby Mama', team_hung: 'Team Hưng',
    team_entremet: 'Team Entremet', team_baker: 'Team Baker',
    // Status
    pending: 'Chưa làm', in_progress: 'Đang làm', done: 'Xong',
    skip: 'Có sẵn', partial: 'Một phần', blocked: 'Bị chặn',
    // Import
    importTitle: 'Nhập đơn hàng Odoo',
    dropHint: 'Kéo thả file Excel Sales Order hoặc Stock Replenishment vào đây',
    browseFiles: 'Chọn file',
    importBtn: 'Nhập & tổng hợp',
    importing: 'Đang nhập…',
    shippedFromLab: 'Giao trực tiếp từ lab',
    notes: 'Ghi chú',
    // Orders
    ordersTitle: 'Đơn sản xuất',
    mainOrder: 'Đơn chính', urgentOrder: 'Đơn khẩn',
    delivery: 'Giao hàng', publishBtn: 'Phát hành cho teams',
    published: 'Đã phát hành', draft: 'Nháp', cancelled: 'Đã huỷ',
    // Assignment
    totalQty: 'Tổng', toProduce: 'Cần làm', produced: 'Đã làm',
    exceptionReason: 'Lý do', saveException: 'Lưu',
    // Dashboard
    today: 'Hôm nay', pending_label: 'Chưa làm',
    // Users
    usersTitle: 'Quản lý người dùng', role: 'Vai trò', team: 'Team',
    addUser: 'Thêm người dùng', saveUser: 'Lưu',
    // Station
    myStation: 'Trạm của tôi', markDone: 'Xong', markProgress: 'Đang làm',
    orderMain: 'Đơn chính', orderUrgent: '🚨 Khẩn',
    fromLab: '⚡ Giao từ lab',
    // Fiches
    fiches: 'Phiếu kỹ thuật', fichesTitle: 'Phiếu kỹ thuật sản xuất',
    ficheStep: 'Bước', ficheAddStep: 'Thêm bước', ficheSave: 'Lưu phiếu',
    ficheDuration: 'Thời gian (phút)', ficheTemp: 'Nhiệt độ (°C)',
    ficheDesc: 'Hướng dẫn', ficheNoSteps: 'Chưa có bước nào',
    ficheViewBtn: 'Xem phiếu',
    // General
    save: 'Lưu', cancel: 'Huỷ', confirm: 'Xác nhận',
    noData: 'Không có dữ liệu', loading: 'Đang tải…', error: 'Đã có lỗi xảy ra',
    search: 'Tìm kiếm', selectDate: 'Chọn ngày',
  },
} as const;

type Key = keyof typeof T.en;

interface I18nCtx { lang: Lang; setLang: (l: Lang) => void; t: (k: Key) => string; }
import React from 'react';
export const I18nContext = createContext<I18nCtx>({ lang: 'vi', setLang: () => {}, t: (k) => k });

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    if (typeof window !== 'undefined') return (localStorage.getItem('lab-lang') as Lang) || 'vi';
    return 'vi';
  });
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem('lab-lang', l);
  }, []);
  const t = useCallback((k: Key) => T[lang][k] ?? k, [lang]);
  return React.createElement(I18nContext.Provider, { value: { lang, setLang, t } }, children);
}

export function useI18n() { return useContext(I18nContext); }
