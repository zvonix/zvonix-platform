import type { MetadataRoute } from 'next';
import { getSiteInfo } from './site-data';

export const revalidate = 3600;

const PATHS = [
  '/',
  '/clients',
  '/partners',
  '/how-it-works',
  '/pricing',
  '/security',
  '/integration',
  '/faq',
  '/contacts',
] as const;

/** Адрес сайта берётся у API; без него (туннель, кабинет не на cp.) карта сайта пуста, а не неверна. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const info = await getSiteInfo();
  if (info.siteUrl === null) return [];
  return PATHS.map((path) => ({
    url: `${info.siteUrl ?? ''}${path === '/' ? '' : path}`,
    changeFrequency: 'weekly',
  }));
}
