import { describe, expect, it } from 'vitest';
import { sipGatewaysXml } from './sip-gateways-xml.js';

describe('sipGatewaysXml', () => {
  it('транков нет — пустой include, который узел примет', () => {
    expect(sipGatewaysXml([])).toBe('<include>\n</include>\n');
  });

  it('транк с регистрацией: адрес, домен без порта, учётная запись', () => {
    const xml = sipGatewaysXml([
      {
        name: 'gw-1',
        proxyHost: 'sip.provider.ru:5070',
        registersOutbound: true,
        username: '21231690871100',
        password: 'секрет',
      },
    ]);
    expect(xml).toContain('<gateway name="gw-1">');
    expect(xml).toContain('<param name="proxy" value="sip.provider.ru:5070"/>');
    expect(xml).toContain('<param name="realm" value="sip.provider.ru"/>');
    expect(xml).toContain('<param name="register" value="true"/>');
    expect(xml).toContain('<param name="username" value="21231690871100"/>');
    expect(xml).toContain('<param name="password" value="секрет"/>');
  });

  it('без регистрации — служебное имя и пустой пароль: без username gateway не поднимется', () => {
    const xml = sipGatewaysXml([
      {
        name: 'gw-2',
        proxyHost: '10.0.0.1',
        registersOutbound: false,
        username: null,
        password: null,
      },
    ]);
    expect(xml).toContain('<param name="register" value="false"/>');
    expect(xml).toContain('<param name="username" value="zvonix"/>');
    expect(xml).toContain('<param name="password" value=""/>');
  });

  it('один транк — одна строка, даже если в пароле перевод строки и кавычки', () => {
    const xml = sipGatewaysXml([
      {
        name: 'gw-a',
        proxyHost: 'a.ru',
        registersOutbound: true,
        username: 'u',
        password: 'p"<&\n\r\tx',
      },
      { name: 'gw-b', proxyHost: 'b.ru', registersOutbound: true, username: 'u', password: 'p' },
    ]);
    const lines = xml.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('<include>');
    expect(lines[3]).toBe('</include>');
    expect(lines[1]).toContain('value="p&quot;&lt;&amp;&#10;&#13;&#9;x"');
    expect(lines[2]).toMatch(/^<gateway name="gw-b">.*<\/gateway>$/u);
  });
});
