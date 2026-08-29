import { NextResponse } from 'next/server';
import { createClient, getSafeSession } from '@/lib/supabase-server';
import { odooExecuteWrite } from '@/lib/odoo';
import { resolveShopWarehouseLocation, resolveProductsBySku, resolveDefaultScrapLocationId, resolveLabWarehouseLocation, getScrapReasonTags } from '@/lib/odoo-scrap';
import { prefillReplenishmentReceivedQty } from '@/lib/odoo-shop-receipt-sync';

// 2026-08-28 LAB inventory prep (Axel): finished-goods stock targets computed from the app's own
// production/transfer data ahead of the 31/08 physical count — see [[stock-inventory-prep-lab-31aout]]
// memory for the full method. qty > 0 = already sent to Odoo stock this afternoon for tomorrow's
// (2026-08-29) delivery and therefore real, physically-present stock; qty 0 = everything else in
// scope. Scope: active finished-goods catalog EXCLUDING Macaron / Tiramisu / Biscuit Voyage (those
// are counted by hand on the day) and excluding two inactive placeholder "Bánh giả-" test SKUs
// (no real category). Re-verified live against lab_assignments immediately before use — unchanged.
const INVENTORY_TARGETS: { sku: string; qty: number }[] = [
  { sku: "MNCH", qty: 0 },
  { sku: "BSNMNCCFM", qty: 0 },
  { sku: "BSNMNCCT", qty: 0 },
  { sku: "BSNMNCT", qty: 0 },
  { sku: "BSNMNCX", qty: 0 },
  { sku: "BSNBMD14", qty: 0 },
  { sku: "BSNBMD16", qty: 0 },
  { sku: "BSNBMD18", qty: 0 },
  { sku: "BSNBMD20", qty: 0 },
  { sku: "BSNBMD22", qty: 0 },
  { sku: "BSNBMD24", qty: 0 },
  { sku: "155-MH.310", qty: 0 },
  { sku: "BSNCS10", qty: 0 },
  { sku: "BSNCS15", qty: 0 },
  { sku: "BSNCS20", qty: 0 },
  { sku: "BCCOD16", qty: 0 },
  { sku: "BCDAD16", qty: 0 },
  { sku: "BCEMD16", qty: 0 },
  { sku: "BCMD16", qty: 0 },
  { sku: "BCNYD16", qty: 0 },
  { sku: "BCNYD24", qty: 0 },
  { sku: "BCTD16", qty: 0 },
  { sku: "BCYD16", qty: 0 },
  { sku: "BCAD14", qty: 0 },
  { sku: "BCAD16", qty: 0 },
  { sku: "BCAD18", qty: 0 },
  { sku: "BCAD20", qty: 0 },
  { sku: "BCAD22", qty: 0 },
  { sku: "BCAD24", qty: 0 },
  { sku: "BCBD14", qty: 0 },
  { sku: "BCBD16", qty: 0 },
  { sku: "BCBD18", qty: 0 },
  { sku: "BCBD20", qty: 0 },
  { sku: "BCBD22", qty: 0 },
  { sku: "BCBD24", qty: 0 },
  { sku: "BCLD18", qty: 0 },
  { sku: "BCLD20", qty: 0 },
  { sku: "BCLD22", qty: 0 },
  { sku: "BCLD24", qty: 0 },
  { sku: "BCLMGD16", qty: 0 },
  { sku: "BCMD14", qty: 0 },
  { sku: "BCLPSD16", qty: 0 },
  { sku: "BCLPSD18", qty: 0 },
  { sku: "BCLPSD20", qty: 0 },
  { sku: "BCLPSD22", qty: 0 },
  { sku: "BCPD14", qty: 0 },
  { sku: "BCPD24", qty: 0 },
  { sku: "BCWD14", qty: 0 },
  { sku: "BCWD16", qty: 0 },
  { sku: "BCWD18", qty: 0 },
  { sku: "BCWD20", qty: 0 },
  { sku: "BCWD22", qty: 0 },
  { sku: "BCWD24", qty: 0 },
  { sku: "BSNDCD16", qty: 0 },
  { sku: "BDRMSD10", qty: 1 },
  { sku: "BDRMSD12", qty: 0 },
  { sku: "BDRMSD14", qty: 1 },
  { sku: "BDRMSD16", qty: 0 },
  { sku: "BDRMSD18", qty: 0 },
  { sku: "BDRMSD20", qty: 0 },
  { sku: "BDRMSD22", qty: 0 },
  { sku: "BDRMSD24", qty: 0 },
  { sku: "BSNAMD14", qty: 0 },
  { sku: "BSNAMD16", qty: 0 },
  { sku: "BSNAMD18", qty: 0 },
  { sku: "BSNAMD20", qty: 0 },
  { sku: "BSNAMD22", qty: 0 },
  { sku: "BSNAMD24", qty: 0 },
  { sku: "BSNPD24", qty: 0 },
  { sku: "BSNPRSD14", qty: 0 },
  { sku: "BSNPRSD16", qty: 0 },
  { sku: "BSNPRSD18", qty: 0 },
  { sku: "BSNPRSD20", qty: 0 },
  { sku: "BSNPRSD22", qty: 0 },
  { sku: "BSNCCLD14", qty: 0 },
  { sku: "BSNCCLD16", qty: 0 },
  { sku: "BSNCCLD18", qty: 0 },
  { sku: "BSNCCLD20", qty: 0 },
  { sku: "BSNCCLD22", qty: 0 },
  { sku: "BSNCCLD24", qty: 0 },
  { sku: "BSNCCMCD14", qty: 0 },
  { sku: "BSNCCMCD16", qty: 0 },
  { sku: "BSNCCMCD18", qty: 0 },
  { sku: "BSNCCMCD20", qty: 0 },
  { sku: "BSNCCMCD22", qty: 0 },
  { sku: "BSNCCMCD24", qty: 0 },
  { sku: "WMGTCCMD10", qty: 0 },
  { sku: "BSNCFL14", qty: 0 },
  { sku: "BSNCFL16", qty: 0 },
  { sku: "BSNCFL18", qty: 0 },
  { sku: "BSNCFL20", qty: 0 },
  { sku: "BSNCFL22", qty: 0 },
  { sku: "BSNCFL24", qty: 0 },
  { sku: "BSNOGRD14", qty: 0 },
  { sku: "BSNOGRD16", qty: 0 },
  { sku: "BSNOGRD18", qty: 0 },
  { sku: "BSNOGRD20", qty: 0 },
  { sku: "BSNOGRD22", qty: 0 },
  { sku: "BSNOGRD24", qty: 0 },
  { sku: "WMOGD10", qty: 0 },
  { sku: "BSNJD18", qty: 0 },
  { sku: "BLPD14C1", qty: 0 },
  { sku: "BLPD16C1", qty: 0 },
  { sku: "BLPD14CSC1", qty: 0 },
  { sku: "BLPD16CSC1", qty: 0 },
  { sku: "BLPD14EGP1", qty: 0 },
  { sku: "BLPD16EGP1", qty: 0 },
  { sku: "BLPD14MC1", qty: 0 },
  { sku: "BLPD16MC1", qty: 0 },
  { sku: "BLPD18MC1", qty: 0 },
  { sku: "BLPD14VM1", qty: 0 },
  { sku: "BLPD16VM1", qty: 0 },
  { sku: "BLPD14C", qty: 0 },
  { sku: "BLPD16C", qty: 0 },
  { sku: "BLPD18C", qty: 0 },
  { sku: "BLPD14CSC", qty: 0 },
  { sku: "BLPD16CSC", qty: 0 },
  { sku: "BLPD18CSC", qty: 0 },
  { sku: "BLPD24CSC", qty: 0 },
  { sku: "BLPD14EGP", qty: 0 },
  { sku: "BLPD16EGP", qty: 0 },
  { sku: "BLPD18EGP", qty: 0 },
  { sku: "BLPD22EGP", qty: 0 },
  { sku: "BLPD24EGP", qty: 0 },
  { sku: "BLPD14MC", qty: 0 },
  { sku: "BLPD16MC", qty: 0 },
  { sku: "BLPD18MC", qty: 0 },
  { sku: "BLPD24MC", qty: 0 },
  { sku: "BLPD14VM", qty: 0 },
  { sku: "BLPD16VM", qty: 0 },
  { sku: "BLPD24VM", qty: 0 },
  { sku: "BLBBD14", qty: 0 },
  { sku: "BLBPD14", qty: 0 },
  { sku: "BLDD14", qty: 0 },
  { sku: "BLPD16", qty: 0 },
  { sku: "BMDD14C", qty: 0 },
  { sku: "BMDD16C", qty: 0 },
  { sku: "BMDD22C", qty: 0 },
  { sku: "BMDD14CSC", qty: 0 },
  { sku: "BMDD16CSC", qty: 0 },
  { sku: "BMDD18CSC", qty: 0 },
  { sku: "BMDD22CSC", qty: 0 },
  { sku: "BMDD14EGP", qty: 0 },
  { sku: "BMDD16EGP", qty: 0 },
  { sku: "BMDD18EGP", qty: 0 },
  { sku: "BMDD22EGP", qty: 0 },
  { sku: "BMDD14MC", qty: 0 },
  { sku: "BMDD16MC", qty: 0 },
  { sku: "BMDD22MC", qty: 0 },
  { sku: "BMDD14VM", qty: 0 },
  { sku: "BMDD16VM", qty: 0 },
  { sku: "BMDD20VM", qty: 0 },
  { sku: "BMDD22VM", qty: 0 },
  { sku: "BMZD14C", qty: 0 },
  { sku: "BMZD16C", qty: 0 },
  { sku: "BMZD20C", qty: 0 },
  { sku: "BMZD22C", qty: 0 },
  { sku: "BMZD14CSC", qty: 0 },
  { sku: "BMZD16CSC", qty: 0 },
  { sku: "BMZD20CSC", qty: 0 },
  { sku: "BMZD22CSC", qty: 0 },
  { sku: "BMZD14EGP", qty: 0 },
  { sku: "BMZD16EGP", qty: 0 },
  { sku: "BMZD20EGP", qty: 0 },
  { sku: "BMZD22EGP", qty: 0 },
  { sku: "BMZD14MC", qty: 0 },
  { sku: "BMZD16MC", qty: 0 },
  { sku: "BMZD20MC", qty: 0 },
  { sku: "BMZD22MC", qty: 0 },
  { sku: "BMZD14VM", qty: 0 },
  { sku: "BMZD16VM", qty: 0 },
  { sku: "BMZD20VM", qty: 0 },
  { sku: "BMZD22VM", qty: 0 },
  { sku: "BND14C", qty: 0 },
  { sku: "BND16C", qty: 0 },
  { sku: "BND20C", qty: 0 },
  { sku: "BND22C", qty: 0 },
  { sku: "BND14CSC", qty: 0 },
  { sku: "BND16CSC", qty: 0 },
  { sku: "BND20CSC", qty: 0 },
  { sku: "BND22CSC", qty: 0 },
  { sku: "BND14EGP", qty: 0 },
  { sku: "BND16EGP", qty: 0 },
  { sku: "BND20EGP", qty: 0 },
  { sku: "BND22EGP", qty: 0 },
  { sku: "BND14MC", qty: 0 },
  { sku: "BND16MC", qty: 0 },
  { sku: "BND20MC", qty: 0 },
  { sku: "BND22MC", qty: 0 },
  { sku: "BND14VM", qty: 0 },
  { sku: "BND16VM", qty: 0 },
  { sku: "BND20VM", qty: 0 },
  { sku: "BND22VM", qty: 0 },
  { sku: "BPVL", qty: 0 },
  { sku: "BSNRBD18", qty: 0 },
  { sku: "BSPLD14", qty: 0 },
  { sku: "BSPLD16", qty: 0 },
  { sku: "BSPLD18", qty: 0 },
  { sku: "BSPLD20", qty: 0 },
  { sku: "BSPLD22", qty: 0 },
  { sku: "BSPLD24", qty: 0 },
  { sku: "BSBD14", qty: 0 },
  { sku: "BSBD16", qty: 0 },
  { sku: "BSBD18", qty: 0 },
  { sku: "BSBD20", qty: 0 },
  { sku: "BSBD22", qty: 0 },
  { sku: "BSBD24", qty: 0 },
  { sku: "BSSD14", qty: 0 },
  { sku: "BSSD16", qty: 0 },
  { sku: "BSSD18", qty: 0 },
  { sku: "BSSD20", qty: 0 },
  { sku: "BSSD22", qty: 0 },
  { sku: "BSSD24", qty: 0 },
  { sku: "BTDCD12", qty: 0 },
  { sku: "BTDCD14", qty: 0 },
  { sku: "BTDCD16", qty: 0 },
  { sku: "BTDCD18", qty: 0 },
  { sku: "BTDCD20", qty: 0 },
  { sku: "BTDCD22", qty: 0 },
  { sku: "BTDCD24", qty: 0 },
  { sku: "BTDHD14", qty: 0 },
  { sku: "BTDHD16", qty: 0 },
  { sku: "BTDHD18", qty: 0 },
  { sku: "BTDHD20", qty: 0 },
  { sku: "BTDHD22", qty: 0 },
  { sku: "BTDHD24", qty: 0 },
  { sku: "BVHD14", qty: 0 },
  { sku: "BVHD16", qty: 0 },
  { sku: "BVHD18", qty: 0 },
  { sku: "BVHD20", qty: 0 },
  { sku: "BVHD22", qty: 0 },
  { sku: "BVHD24", qty: 0 },
  { sku: "BMMRD18", qty: 0 },
  { sku: "BTGD16", qty: 0 },
  { sku: "BCC", qty: 1 },
  { sku: "BBF1", qty: 0 },
  { sku: "BBCFC", qty: 0 },
  { sku: "S-BBCFCC", qty: 0 },
  { sku: "WBCFC", qty: 0 },
  { sku: "BCCL", qty: 3 },
  { sku: "BCPRT", qty: 0 },
  { sku: "WMCCS2", qty: 0 },
  { sku: "BSTF", qty: 0 },
  { sku: "S-BBSFC1", qty: 0 },
  { sku: "WBSF1", qty: 0 },
  { sku: "BPCCFG", qty: 0 },
  { sku: "S-BBPCFB", qty: 0 },
  { sku: "WBPCF", qty: 0 },
  { sku: "BBPTF", qty: 0 },
  { sku: "S-BBPFC", qty: 0 },
  { sku: "WMPF", qty: 0 },
  { sku: "BK", qty: 0 },
  { sku: "BGRF", qty: 0 },
  { sku: "S-BBGFC", qty: 0 },
  { sku: "WBGF", qty: 0 },
  { sku: "BBMCF", qty: 0 },
  { sku: "S-BBMCFC", qty: 0 },
  { sku: "WMMCH", qty: 0 },
  { sku: "BMCDL", qty: 0 },
  { sku: "WMMCDLMN", qty: 0 },
  { sku: "BMATCHAF", qty: 0 },
  { sku: "S-BBMFB2", qty: 0 },
  { sku: "WBMF1", qty: 0 },
  { sku: "BOROL", qty: 0 },
  { sku: "WMOROLMN", qty: 0 },
  { sku: "BPFTC", qty: 3 },
  { sku: "BRNM", qty: 3 },
  { sku: "WBRN110G", qty: 2 },
  { sku: "BSF", qty: 0 },
  { sku: "S-BBSFC", qty: 0 },
  { sku: "WBSF", qty: 0 },
  { sku: "BMGFG", qty: 0 },
  { sku: "S-BBMFC", qty: 0 },
  { sku: "WBMF", qty: 0 },
  { sku: "BYK", qty: 6 },
  { sku: "WBY70G", qty: 2 },
  { sku: "BY", qty: 0 },
  { sku: "WMCPRMN", qty: 0 },
  { sku: "SCWM6C", qty: 0 },
  { sku: "BBBBC", qty: 0 },
  { sku: "BBK", qty: 0 },
  { sku: "BBL", qty: 0 },
  { sku: "BBM", qty: 0 },
  { sku: "BBB2", qty: 0 },
  { sku: "BBC", qty: 0 },
  { sku: "STC", qty: 0 },
  { sku: "STH", qty: 0 },
  { sku: "STM1", qty: 0 },
  { sku: "STM", qty: 0 },
  { sku: "STO", qty: 0 },
  { sku: "STS", qty: 0 },
  { sku: "BCCL1C", qty: 0 },
  { sku: "NAS", qty: 0 },
  { sku: "NUM", qty: 0 },
  { sku: "NBB", qty: 0 },
  { sku: "NHTF", qty: 0 },
  { sku: "NHC", qty: 0 },
  { sku: "NKB", qty: 0 },
  { sku: "NSS1", qty: 0 },
  { sku: "NCZ", qty: 0 },
  { sku: "NSS", qty: 0 },
  { sku: "BEPN", qty: 0 },
  { sku: "BEHN", qty: 0 },
  { sku: "BERFN", qty: 1 },
  { sku: "BECN", qty: 0 },
  { sku: "BEVCN", qty: 0 },
  { sku: "BEBBN", qty: 1 },
  { sku: "BPBH", qty: 0 },
  { sku: "BPBMACA", qty: 0 },
  { sku: "BPBMC", qty: 0 },
  { sku: "BPBP", qty: 0 },
  { sku: "BBMM", qty: 0 },
  { sku: "BDD", qty: 0 },
  { sku: "B8PM", qty: 0 },
  { sku: "BBGM", qty: 0 },
  { sku: "BBB", qty: 0 },
  { sku: "BBF", qty: 0 },
  { sku: "BCRMLA", qty: 0 },
  { sku: "BH", qty: 0 },
  { sku: "BJLETA", qty: 0 },
  { sku: "BLM", qty: 0 },
  { sku: "BMGM", qty: 0 },
  { sku: "BMKC", qty: 0 },
  { sku: "BN", qty: 0 },
  { sku: "BO", qty: 0 },
  { sku: "BTT", qty: 0 },
  { sku: "BNT", qty: 0 },
  { sku: "BPT", qty: 0 },
  { sku: "BVL", qty: 0 },
  { sku: "SLDS", qty: 0 },
  { sku: "BDT", qty: 0 },
  { sku: "BMLLFSCL", qty: 0 },
  { sku: "BMF", qty: 0 },
  { sku: "BCA", qty: 0 },
  { sku: "BCB", qty: 0 },
  { sku: "BCM", qty: 0 },
  { sku: "BCP", qty: 0 },
  { sku: "BCW", qty: 0 },
  { sku: "BCD1", qty: 0 },
  { sku: "BCQMM", qty: 0 },
  { sku: "BSCR", qty: 0 },
  { sku: "BCSR", qty: 0 },
  { sku: "BEBM", qty: 0 },
  { sku: "BECC1", qty: 0 },
  { sku: "BECC", qty: 0 },
  { sku: "BEEC", qty: 0 },
  { sku: "BEJB", qty: 0 },
  { sku: "BGH", qty: 0 },
  { sku: "BJB", qty: 0 },
  { sku: "BLS", qty: 0 },
  { sku: "BLB", qty: 0 },
  { sku: "BLJ", qty: 0 },
  { sku: "BGB", qty: 0 },
  { sku: "BSPCB", qty: 0 },
  { sku: "BMCB", qty: 0 },
  { sku: "BLCB", qty: 0 },
  { sku: "BCPB", qty: 0 },
  { sku: "BCSB", qty: 0 },
  { sku: "BLSEB", qty: 0 },
  { sku: "BCSP", qty: 0 },
  { sku: "BCSPO", qty: 0 },
  { sku: "BCQC", qty: 0 },
  { sku: "BCQM", qty: 0 },
  { sku: "155-MH.303", qty: 0 },
  { sku: "BAB", qty: 0 },
  { sku: "BAC", qty: 0 },
  { sku: "BAC1", qty: 0 },
  { sku: "BAM", qty: 0 },
  { sku: "BBB1", qty: 0 },
  { sku: "BDB", qty: 0 },
  { sku: "BCBQ", qty: 0 },
  { sku: "BMSBDT", qty: 0 },
  { sku: "BMSBHN", qty: 0 },
  { sku: "BMSBP", qty: 0 },
  { sku: "BCCC", qty: 0 },
  { sku: "BMSBMC", qty: 0 },
  { sku: "BCMC", qty: 0 },
  { sku: "BCMB", qty: 0 },
  { sku: "BMSBQM", qty: 0 },
  { sku: "BCTM", qty: 0 },
  { sku: "BBC1", qty: 0 },
  { sku: "SBCPB", qty: 0 },
  { sku: "SCE", qty: 0 },
  { sku: "BBO", qty: 0 },
  { sku: "BCYN", qty: 0 },
  { sku: "WMS60", qty: 0 },
  { sku: "BCOD", qty: 0 },
  { sku: "BCD", qty: 0 },
  { sku: "BDT1", qty: 0 },
  { sku: "BROCH", qty: 0 },
  { sku: "BBM1", qty: 0 },
  { sku: "BNYM", qty: 0 },
  { sku: "BNYRHD", qty: 0 },
  { sku: "BNYRHP", qty: 0 },
  { sku: "BNYX", qty: 0 },
  { sku: "BRM", qty: 0 },
  { sku: "BRN", qty: 0 },
  { sku: "BRR", qty: 0 },
  { sku: "BRS", qty: 0 },
  { sku: "BSCC", qty: 0 },
  { sku: "BST", qty: 0 },
  { sku: "BMPA", qty: 0 },
  { sku: "BBPAC", qty: 0 },
  { sku: "SBPACAOC", qty: 0 },
  { sku: "BPE", qty: 0 },
  { sku: "BBGBR", qty: 0 },
  { sku: "BCFM", qty: 0 },
  { sku: "BCLM", qty: 0 },
  { sku: "BCMM", qty: 0 },
  { sku: "BCMM1", qty: 0 },
  { sku: "BCSM", qty: 0 },
];

// Staff-only diagnostic/fix tool for stock.scrap records created via the shop portal.
// Axel, 2026-08-27: reported a scrap he created through the shop loss-report flow shows as
// 'draft' in Odoo even though createShopScrap() (odoo-scrap.ts) calls action_validate right
// after create and never sees an error — meaning action_validate is returning something instead
// of raising (most likely an insufficient-quantity confirmation wizard action, which Odoo returns
// as a dict rather than throwing), and our code silently ignores that return value. This route
// exists to (a) inspect a scrap's real state + what action_validate actually returns, and
// (b) let a specific test/mistaken scrap be cancelled cleanly, without touching the app's own
// createShopScrap() write path yet — kept separate on purpose until the actual cause is
// confirmed from a real response, not guessed.
async function requireStaff() {
  const supabase = createClient();
  const { data: { session } } = await getSafeSession(supabase);
  if (!session) return { error: 'Not authenticated' as const };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', session.user.id).single();
  if (!['admin', 'lab_manager', 'assistant'].includes(profile?.role ?? '')) return { error: 'Forbidden' as const };
  return { ok: true as const };
}

export async function GET(req: Request) {
  const auth = await requireStaff();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: 403 });

  const url = new URL(req.url);
  const id = Number(url.searchParams.get('id'));
  const action = url.searchParams.get('action') ?? 'inspect';
  const idlessActions = new Set(['productname', 'fields', 'reporder', 'testprefill', 'lablocation', 'modulecheck', 'invcheck', 'invset', 'invbatch', 'labquants', 'saleablecat', 'reasontags', 'reasontagcreate']);
  if (!id && !idlessActions.has(action)) return NextResponse.json({ error: 'Missing ?id=' }, { status: 400 });

  try {
    if (action === 'reasontags') {
      // Read-only (2026-08-29, Axel: manager wants more scrap reasons -- "Test", "out of
      // date"). Raw, UNFILTERED list of stock.scrap.reason.tag from Odoo, to see what already
      // exists before deciding whether to add new tags or just widen the app's own keyword
      // filter (odoo-scrap.ts reduceLossReasons in shop/actions.ts + lab-scrap/actions.ts).
      const tags = await getScrapReasonTags();
      return NextResponse.json({ tags });
    }
    if (action === 'reasontagcreate') {
      // Write (2026-08-29): create a new stock.scrap.reason.tag. ?name= required.
      const name = url.searchParams.get('name') ?? '';
      if (!name) return NextResponse.json({ error: 'Missing ?name=' }, { status: 400 });
      const newId = await odooExecuteWrite<number>('stock.scrap.reason.tag', 'create', [{ name }]);
      return NextResponse.json({ ok: true, id: newId, name });
    }
    if (action === 'modulecheck') {
      // Read-only diagnosis (2026-08-27, Axel: purchase workflow redesign with Miss Flavor —
      // "option 2" = the OCA purchase_request module family). Checks install state of every
      // module in that suite, and if the core one is installed, introspects its model/workflow
      // before any decision is made. Zero writes.
      const names = [
        'purchase_request', 'purchase_request_to_po', 'purchase_request_line_procurement',
        'purchase_request_department', 'purchase_request_tier_validation', 'purchase_request_budget',
      ];
      const modules = await odooExecuteWrite<any[]>('ir.module.module', 'search_read',
        [[['name', 'in', names]]], { fields: ['name', 'state', 'shortdesc', 'installed_version'] });
      let modelInfo: any = null;
      let sampleCount: number | null = null;
      let lineFields: string[] | null = null;
      let groups: any[] | null = null;
      const coreInstalled = modules.some(m => m.name === 'purchase_request' && m.state === 'installed');
      if (coreInstalled) {
        modelInfo = await odooExecuteWrite<Record<string, any>>('purchase.request', 'fields_get',
          [], { attributes: ['string', 'type', 'selection', 'required', 'help'] });
        sampleCount = await odooExecuteWrite<number>('purchase.request', 'search_count', [[]]);
        const lineFieldsObj = await odooExecuteWrite<Record<string, any>>('purchase.request.line', 'fields_get',
          [], { attributes: ['string', 'type'] });
        lineFields = Object.keys(lineFieldsObj);
        groups = await odooExecuteWrite<any[]>('res.groups', 'search_read',
          [[['category_id.name', '=', 'Purchase Request']]], { fields: ['name', 'full_name'] });
      }
      return NextResponse.json({ modules, coreInstalled, sampleCount, groups, purchaseRequestStateOptions: modelInfo?.state?.selection ?? null, purchaseRequestKeyFields: modelInfo ? Object.keys(modelInfo) : null, lineFields });
    }
    if (action === 'lablocation') {
      // Read-only check for the new LAB scrap feature (2026-08-27): confirms resolveLabWarehouseLocation
      // actually resolves a real Odoo location via warehouse code 'LAB', before trusting the UI.
      const loc = await resolveLabWarehouseLocation();
      return NextResponse.json({ loc });
    }
    if (action === 'testprefill') {
      // End-to-end test of prefillReplenishmentReceivedQty against a REAL REP order/line, using
      // a value equal to the line's own quantity_requested so the test is realistic, then reverts
      // quantity_received back to its original value afterward — no permanent data change, unlike
      // the scrap-wizard test (that one couldn't be undone once 'done'; a plain float field write
      // can always be reverted).
      const ref = url.searchParams.get('ref') ?? '';
      const sku = url.searchParams.get('sku') ?? '';
      if (!ref || !sku) return NextResponse.json({ error: 'Missing ?ref= or ?sku=' }, { status: 400 });
      const before = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'search_read',
        [[['request_id.name', '=', ref]]], { fields: ['id', 'product_id', 'quantity_requested', 'quantity_received'] });
      const targetLine = before.find((l: any) => Array.isArray(l.product_id) && String(l.product_id[1]).includes(`[${sku}]`));
      if (!targetLine) return NextResponse.json({ error: `No REP line found for ${sku} on ${ref}`, before });
      const originalReceived = targetLine.quantity_received;
      const testQty = targetLine.quantity_requested;
      const result = await prefillReplenishmentReceivedQty(ref, [{ sku, qtyReceived: testQty }]);
      const after = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'read', [[targetLine.id]], { fields: ['quantity_received'] });
      // Revert
      await odooExecuteWrite('stock.replenishment.request.line', 'write', [[targetLine.id], { quantity_received: originalReceived }]);
      const reverted = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'read', [[targetLine.id]], { fields: ['quantity_received'] });
      return NextResponse.json({ result, before: { id: targetLine.id, originalReceived, testQty }, afterWrite: after[0], afterRevert: reverted[0] });
    }
    if (action === 'fields') {
      // Read-only introspection for Axel's request (2026-08-27): "prefill the reception quantity
      // on the REP order when the shop finishes its receipt check" — need to know whether
      // stock.replenishment.request(.line) has its OWN received-qty field (separate from the
      // stock.move/picking flow odoo-delivery-validate.ts already writes), before designing
      // anything.
      const model = url.searchParams.get('model') ?? 'stock.replenishment.request.line';
      const fields = await odooExecuteWrite<Record<string, any>>(model, 'fields_get', [], { attributes: ['string', 'type', 'help'] });
      return NextResponse.json({ model, fields });
    }
    if (action === 'reporder') {
      // Read-only: full field dump for one real REP order's lines, to see actual values in any
      // received-qty-looking field once found via `fields`.
      const ref = url.searchParams.get('ref') ?? '';
      if (!ref) return NextResponse.json({ error: 'Missing ?ref=' }, { status: 400 });
      const reqs = await odooExecuteWrite<any[]>('stock.replenishment.request', 'search_read', [[['name', '=', ref]]], { fields: ['id', 'name', 'state'] });
      const req = reqs[0];
      if (!req) return NextResponse.json({ error: 'not found' });
      const lines = await odooExecuteWrite<any[]>('stock.replenishment.request.line', 'search_read', [[['request_id', '=', req.id]]], { fields: [] });
      return NextResponse.json({ req, lines });
    }
    if (action === 'productname') {
      // Read-only check for Axel's report (2026-08-27): "Bánh La Plume D14" shows on the app
      // without its flavor even though the product has variants in Odoo. Hypothesis: our sync
      // reads product.product's plain `name` field, which is related to the TEMPLATE name and
      // does NOT include the variant's attribute values (e.g. flavor) — only `display_name`
      // (Odoo's name_get, which appends "(Attribute: Value)") carries that. Confirming before
      // touching odoo-sync.ts's skuByProductId build.
      const q = url.searchParams.get('q') ?? '';
      if (!q) return NextResponse.json({ error: 'Missing ?q= (name search or exact sku)' }, { status: 400 });
      const rows = await odooExecuteWrite<any[]>('product.product', 'search_read', [
        ['|', ['name', 'ilike', q], ['default_code', '=', q]],
      ], { fields: ['default_code', 'name', 'display_name', 'product_template_attribute_value_ids'], limit: 20 });
      return NextResponse.json({ rows });
    }
    if (action === 'stock') {
      const sku = url.searchParams.get('sku') ?? '';
      const shop = url.searchParams.get('shop') ?? '';
      if (!sku || !shop) return NextResponse.json({ error: 'Missing ?sku= or ?shop=' }, { status: 400 });
      const loc = await resolveShopWarehouseLocation(shop);
      const products = await resolveProductsBySku([sku]);
      const product = products[sku];
      if (!loc || !product) return NextResponse.json({ error: 'shop or sku not resolved', loc, product });
      // qty_available scoped to the shop's OWN location — this is what action_validate's
      // insufficient-quantity check actually reads (company-wide qty_available would look fine
      // even when the shop's own location has 0).
      const rows = await odooExecuteWrite<any[]>('product.product', 'read', [[product.id]], {
        fields: ['qty_available', 'virtual_available'], context: { location: loc.locationId },
      });
      return NextResponse.json({ shopLocation: loc, product, qtyAtShopLocation: rows[0] });
    }
    if (action === 'testvalidate') {
      // Creates a real (tiny) scrap the same way createShopScrap() does, then calls
      // action_validate and returns its RAW result untouched — this is the only way to see the
      // actual wizard payload Odoo returns for insufficient qty, instead of guessing model/field
      // names. Cleans itself up (unlink) if it's still draft afterward.
      const sku = url.searchParams.get('sku') ?? '';
      const shop = url.searchParams.get('shop') ?? '';
      if (!sku || !shop) return NextResponse.json({ error: 'Missing ?sku= or ?shop=' }, { status: 400 });
      const loc = await resolveShopWarehouseLocation(shop);
      const products = await resolveProductsBySku([sku]);
      const product = products[sku];
      const scrapLocationId = await resolveDefaultScrapLocationId();
      if (!loc || !product || !scrapLocationId) return NextResponse.json({ error: 'setup not resolved', loc, product, scrapLocationId });
      const scrapId = await odooExecuteWrite<number>('stock.scrap', 'create', [{
        product_id: product.id, product_uom_id: product.uom_id, scrap_qty: 1,
        location_id: loc.locationId, scrap_location_id: scrapLocationId,
        origin: 'DEBUG_TEST_DELETE_ME',
      }]);
      const validateResult = await odooExecuteWrite<any>('stock.scrap', 'action_validate', [[scrapId]]);
      const after = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[scrapId]], { fields: ['state'] });
      let cleaned = false;
      if (after[0]?.state !== 'done') {
        try { await odooExecuteWrite('stock.scrap', 'unlink', [[scrapId]]); cleaned = true; } catch {}
      }
      return NextResponse.json({ scrapId, validateResult, stateAfter: after[0]?.state ?? null, cleaned });
    }
    if (action === 'testwizard') {
      // End-to-end test of the actual fix now in odoo-scrap.ts's createShopScrap(): create a
      // real tiny scrap, hit the insufficient-qty wizard, confirm it via action_done, and report
      // the final state. NOT cleaned up automatically if it ends up 'done' (a done stock.scrap
      // can't be safely unlinked) — caller is expected to compensate manually if this was purely
      // a test, same as any other real scrap.
      const sku = url.searchParams.get('sku') ?? '';
      const shop = url.searchParams.get('shop') ?? '';
      if (!sku || !shop) return NextResponse.json({ error: 'Missing ?sku= or ?shop=' }, { status: 400 });
      const loc = await resolveShopWarehouseLocation(shop);
      const products = await resolveProductsBySku([sku]);
      const product = products[sku];
      const scrapLocationId = await resolveDefaultScrapLocationId();
      if (!loc || !product || !scrapLocationId) return NextResponse.json({ error: 'setup not resolved', loc, product, scrapLocationId });
      const scrapId = await odooExecuteWrite<number>('stock.scrap', 'create', [{
        product_id: product.id, product_uom_id: product.uom_id, scrap_qty: 1,
        location_id: loc.locationId, scrap_location_id: scrapLocationId,
        origin: 'DEBUG_TESTWIZARD_DELETE_ME',
      }]);
      const validateResult = await odooExecuteWrite<any>('stock.scrap', 'action_validate', [[scrapId]]);
      let wizardResult: any = null;
      if (validateResult?.res_model === 'stock.warn.insufficient.qty.scrap') {
        const ctx = validateResult.context ?? {};
        const wizardId = await odooExecuteWrite<number>('stock.warn.insufficient.qty.scrap', 'create', [{
          product_id: ctx.default_product_id, location_id: ctx.default_location_id,
          scrap_id: ctx.default_scrap_id, quantity: ctx.default_quantity,
          product_uom_name: ctx.default_product_uom_name,
        }]);
        wizardResult = await odooExecuteWrite<any>('stock.warn.insufficient.qty.scrap', 'action_done', [[wizardId]]);
      }
      const after = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[scrapId]], { fields: ['state'] });
      return NextResponse.json({ scrapId, validateResult, wizardResult, stateAfter: after[0]?.state ?? null });
    }
    if (action === 'recent') {
      const rows = await odooExecuteWrite<any[]>('stock.scrap', 'search_read', [[]], {
        fields: ['state', 'product_id', 'scrap_qty', 'location_id', 'origin', 'create_date'],
        order: 'id desc', limit: 10,
      });
      return NextResponse.json({ rows });
    }
    if (action === 'inspect') {
      const rows = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[id]], {
        fields: ['state', 'product_id', 'scrap_qty', 'location_id', 'scrap_location_id', 'origin'],
      });
      const scrap = rows[0];
      let qtyAvailable: any = null;
      if (scrap?.product_id) {
        const pid = Array.isArray(scrap.product_id) ? scrap.product_id[0] : scrap.product_id;
        const prod = await odooExecuteWrite<any[]>('product.product', 'read', [[pid]], { fields: ['qty_available', 'name', 'default_code'] });
        qtyAvailable = prod[0];
      }
      return NextResponse.json({ scrap, qtyAvailable });
    }
    if (action === 'validate') {
      const result = await odooExecuteWrite<any>('stock.scrap', 'action_validate', [[id]]);
      const after = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[id]], { fields: ['state'] });
      return NextResponse.json({ validateResult: result, stateAfter: after[0]?.state ?? null });
    }
    if (action === 'cancel') {
      const rows = await odooExecuteWrite<any[]>('stock.scrap', 'read', [[id]], { fields: ['state'] });
      const state = rows[0]?.state;
      if (state === 'done') return NextResponse.json({ error: `Scrap is already 'done' — cannot cancel/unlink safely from here` }, { status: 400 });
      // Draft scraps can just be unlinked outright.
      await odooExecuteWrite('stock.scrap', 'unlink', [[id]]);
      return NextResponse.json({ ok: true, unlinked: id });
    }
    if (action === 'labquants') {
      // Read-only audit (2026-08-28, Axel spotted Socola/Chocolate SKUs with nonzero LAB stock
      // that the 31/08 pre-adjustment batch never touched): list EVERY stock.quant Odoo actually
      // holds at the LAB location, regardless of whether it's in our app's own product catalogs.
      // Used to find the true gap between "what Odoo tracks at LAB" and "what INVENTORY_TARGETS
      // covered" (which was sourced from lab_fiche_meta only, not the full products table, and
      // definitely not Odoo's raw product.product universe).
      const loc = await resolveLabWarehouseLocation();
      if (!loc) return NextResponse.json({ error: 'LAB location not resolved' }, { status: 500 });
      const quants = await odooExecuteWrite<any[]>('stock.quant', 'search_read', [
        [['location_id', '=', loc.locationId]],
      ], { fields: ['product_id', 'quantity', 'inventory_quantity'], limit: 2000 });
      const productIds = Array.from(new Set(quants.map((q: any) => q.product_id[0])));
      const products = await odooExecuteWrite<any[]>('product.product', 'read', [productIds], { fields: ['default_code', 'name', 'active'] });
      const bySkuRow = quants.map((q: any) => {
        const p = products.find((pp: any) => pp.id === q.product_id[0]);
        return { productId: q.product_id[0], sku: p?.default_code ?? null, name: p?.name ?? q.product_id[1], active: p?.active ?? null, quantity: q.quantity };
      });
      return NextResponse.json({ loc, total: bySkuRow.length, rows: bySkuRow });
    }
    if (action === 'saleablecat') {
      // Read-only (2026-08-28, Axel's own screenshot): Odoo has an authoritative category
      // "All / Saleable Products" (sản phẩm bán được) with exactly 103 members. This is a much
      // better source of truth than our app's own catalog tables (lab_fiche_meta/products/
      // product_variants), which the 08-28 audit proved have real gaps. List every product in
      // this category with its current LAB-location quantity, so we can decide 0-vs-keep per SKU
      // against what was actually sent to stock this afternoon.
      const cats = await odooExecuteWrite<any[]>('product.category', 'search_read', [
        [['complete_name', 'ilike', 'Saleable']],
      ], { fields: ['id', 'complete_name'] });
      if (!cats.length) return NextResponse.json({ error: 'category not found' });
      const catIds = cats.map((c: any) => c.id);
      const loc = await resolveLabWarehouseLocation();
      if (!loc) return NextResponse.json({ error: 'LAB location not resolved' }, { status: 500 });
      // child_of (not plain 'in') so any subcategories under "Saleable Products" are included too.
      const products = await odooExecuteWrite<any[]>('product.product', 'search_read', [
        [['categ_id', 'child_of', catIds]],
      ], { fields: ['default_code', 'name', 'active'], limit: 2000, context: { active_test: false } });
      const productIds = products.map((p: any) => p.id);
      const quants = await odooExecuteWrite<any[]>('stock.quant', 'search_read', [
        [['location_id', '=', loc.locationId], ['product_id', 'in', productIds]],
      ], { fields: ['product_id', 'quantity'] });
      const rows = products.map((p: any) => {
        const q = quants.find((qq: any) => qq.product_id[0] === p.id);
        return { productId: p.id, sku: p.default_code, name: p.name, active: p.active, quantityAtLab: q?.quantity ?? 0 };
      });
      return NextResponse.json({ categories: cats, loc, total: rows.length, rows });
    }
    if (action === 'invcheck') {
      // Read-only (2026-08-28, Axel: prep for the 31/08 LAB inventory — pre-adjust finished-goods
      // stock now so assistants only physically count Macaron/Tiramisu/Biscuit Voyage on the day).
      // Confirms the write mechanism (stock.quant.inventory_quantity + action_apply_inventory)
      // before touching anything: resolves the product + LAB location, and shows the existing
      // quant row(s) there, if any.
      const sku = url.searchParams.get('sku') ?? '';
      if (!sku) return NextResponse.json({ error: 'Missing ?sku=' }, { status: 400 });
      const loc = await resolveLabWarehouseLocation();
      const products = await resolveProductsBySku([sku]);
      const product = products[sku];
      if (!loc || !product) return NextResponse.json({ error: 'lab location or sku not resolved', loc, product });
      const quants = await odooExecuteWrite<any[]>('stock.quant', 'search_read', [
        [['product_id', '=', product.id], ['location_id', '=', loc.locationId]],
      ], { fields: ['id', 'quantity', 'inventory_quantity', 'inventory_quantity_set'] });
      return NextResponse.json({ loc, product, quants });
    }
    if (action === 'invset') {
      // Sets the COUNTED quantity for one SKU at the LAB location and applies it (real write —
      // this is the actual inventory-adjustment mechanism, tested on a single SKU first). Creates
      // the quant row if none exists yet at that location (a SKU that's genuinely always at 0
      // there may never have had one). Returns before/after `quantity` (theoretical on-hand) so
      // the effect is directly visible.
      const sku = url.searchParams.get('sku') ?? '';
      const productIdParam = url.searchParams.get('productId');
      const qtyParam = url.searchParams.get('qty');
      if ((!sku && !productIdParam) || qtyParam === null) return NextResponse.json({ error: 'Missing ?sku= (or ?productId=) or ?qty=' }, { status: 400 });
      const qty = Number(qtyParam);
      const loc = await resolveLabWarehouseLocation();
      let product: { id: number } | undefined;
      if (productIdParam) {
        product = { id: Number(productIdParam) };
      } else {
        const products = await resolveProductsBySku([sku]);
        product = products[sku];
      }
      if (!loc || !product) return NextResponse.json({ error: 'lab location or sku not resolved', loc, product });
      const existing = await odooExecuteWrite<any[]>('stock.quant', 'search_read', [
        [['product_id', '=', product.id], ['location_id', '=', loc.locationId]],
      ], { fields: ['id', 'quantity'] });
      const before = existing[0]?.quantity ?? 0;
      let quantId: number;
      if (existing[0]) {
        quantId = existing[0].id;
        await odooExecuteWrite('stock.quant', 'write', [[quantId], { inventory_quantity: qty }]);
      } else {
        quantId = await odooExecuteWrite<number>('stock.quant', 'create', [{
          product_id: product.id, location_id: loc.locationId, inventory_quantity: qty,
        }]);
      }
      const applyResult = await odooExecuteWrite<any>('stock.quant', 'action_apply_inventory', [[quantId]]);
      const after = await odooExecuteWrite<any[]>('stock.quant', 'read', [[quantId]], { fields: ['quantity'] });
      return NextResponse.json({ sku, quantId, before, target: qty, applyResult, after: after[0]?.quantity ?? null });
    }
    if (action === 'invbatch') {
      // The real 31/08 prep run: sets every SKU in INVENTORY_TARGETS to its target counted
      // quantity at the LAB location. Same mechanism as invset, just looped — proven on a
      // single SKU first via invset before this was ever called for real.
      // Sliced via ?start=&limit= because a full 411-SKU pass exceeds Vercel's 300s function
      // limit (confirmed live: full run timed out with no result). Each write is idempotent
      // (search-or-create then set inventory_quantity then apply), so slices can safely
      // overlap or be re-run without side effects.
      const startParam = Number(url.searchParams.get('start') ?? '0');
      const limitParam = url.searchParams.get('limit');
      const start = Number.isFinite(startParam) && startParam >= 0 ? startParam : 0;
      const end = limitParam ? start + Number(limitParam) : INVENTORY_TARGETS.length;
      const slice = INVENTORY_TARGETS.slice(start, end);
      const results: { sku: string; ok: boolean; before?: number; after?: number; error?: string }[] = [];
      const loc = await resolveLabWarehouseLocation();
      if (!loc) return NextResponse.json({ error: 'LAB location not resolved' }, { status: 500 });
      const skus = slice.map(t => t.sku);
      const products = await resolveProductsBySku(skus);
      for (const t of slice) {
        const product = products[t.sku];
        if (!product) { results.push({ sku: t.sku, ok: false, error: 'sku not resolved in Odoo' }); continue; }
        try {
          const existing = await odooExecuteWrite<any[]>('stock.quant', 'search_read', [
            [['product_id', '=', product.id], ['location_id', '=', loc.locationId]],
          ], { fields: ['id', 'quantity'] });
          const before = existing[0]?.quantity ?? 0;
          let quantId: number;
          if (existing[0]) {
            quantId = existing[0].id;
            await odooExecuteWrite('stock.quant', 'write', [[quantId], { inventory_quantity: t.qty }]);
          } else {
            quantId = await odooExecuteWrite<number>('stock.quant', 'create', [{
              product_id: product.id, location_id: loc.locationId, inventory_quantity: t.qty,
            }]);
          }
          await odooExecuteWrite('stock.quant', 'action_apply_inventory', [[quantId]]);
          const after = await odooExecuteWrite<any[]>('stock.quant', 'read', [[quantId]], { fields: ['quantity'] });
          results.push({ sku: t.sku, ok: true, before, after: after[0]?.quantity ?? null });
        } catch (e: any) {
          results.push({ sku: t.sku, ok: false, error: String(e?.message ?? e) });
        }
      }
      const failed = results.filter(r => !r.ok);
      return NextResponse.json({
        start, end, sliceSize: slice.length, grandTotal: INVENTORY_TARGETS.length,
        total: results.length, succeeded: results.length - failed.length, failed, results,
      });
    }
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
