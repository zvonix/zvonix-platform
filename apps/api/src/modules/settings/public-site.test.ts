import { describe, expect, it } from 'vitest';
import { siteUrlOf } from './public-site.controller.js';

describe('siteUrlOf', () => {
  it('кабинет на cp.<домен> даёт основной домен', () => {
    expect(siteUrlOf('https://cp.zvonix.com')).toBe('https://zvonix.com');
    expect(siteUrlOf('https://cp.example.co.uk/')).toBe('https://example.co.uk');
  });

  it('кабинет на другом имени, туннель или мусор — сайта нет', () => {
    expect(siteUrlOf('https://panel.zvonix.com')).toBeNull();
    expect(siteUrlOf('http://localhost:8080')).toBeNull();
    expect(siteUrlOf('http://cp.zvonix.com')).toBeNull();
    expect(siteUrlOf('https://cp.localhost')).toBeNull();
    expect(siteUrlOf('не адрес')).toBeNull();
  });
});
