import type { MetadataRoute } from 'next';
import { getSiteInfo } from './site-data';

export const revalidate = 3600;

/** Поисковикам открыт только сайт; кабинет закрыт своим заголовком и мета-тегом. */
export default async function robots(): Promise<MetadataRoute.Robots> {
  const info = await getSiteInfo();
  return {
    rules: { userAgent: '*', allow: '/' },
    ...(info.siteUrl === null ? {} : { sitemap: `${info.siteUrl}/sitemap.xml` }),
  };
}
