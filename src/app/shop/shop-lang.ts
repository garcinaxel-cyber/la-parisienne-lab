'use client';
import { createContext, useContext } from 'react';

// Vietnamese / English for the shop & event screens (Axel, 2026-10-07: "peux tu mettre une
// version anglais aussi"). Deliberately tiny: no dictionary file, no keys — every label is
// written once, in place, as L('tiếng Việt', 'English'), so the two versions can never drift
// apart or go missing. ShopView owns the choice and provides it; the tabs it renders read it
// through useShopL(). Outside a provider everything stays Vietnamese, the shops' language.
export type ShopLang = 'vi' | 'en';
export type ShopL = (vi: string, en: string) => string;

export const ShopLangContext = createContext<ShopLang>('vi');

export const pickLang = (lang: ShopLang): ShopL => (vi, en) => (lang === 'en' ? en : vi);

export function useShopLang(): ShopLang {
  return useContext(ShopLangContext);
}

export function useShopL(): ShopL {
  return pickLang(useContext(ShopLangContext));
}
