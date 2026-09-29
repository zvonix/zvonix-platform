/**
 * Кабинет в настоящем браузере.
 *
 * Отвечает на то, что не закрывает ни один другой шаг проверки: **оживает ли
 * страница**. Типы, линтер и сборка бывают зелёными у кабинета, который отдаётся
 * и не работает, — так уже было с источником запросов (`127.0.0.1` против
 * `localhost`): страница приходила, а формы отправлялись браузером мимо кабинета.
 *
 * Проверяется то, что видно только отсюда: сессия в cookie `HttpOnly`
 * ([ADR-0037](../docs/adr/0037-sessiya-v-brauzere.md)), разводка по ролям
 * и правило «действие, недоступное роли, не рисуется»
 * ([DESIGN.md](../docs/DESIGN.md)). Права как таковые проверяет API — здесь
 * проверяется, что человек их видит.
 */

import { expect, test, type Page } from '@playwright/test';

const PASSWORD = process.env['E2E_PASSWORD'] ?? '';

const PEOPLE = {
  admin: 'admin@e2e.zvonix.test',
  support: 'support@e2e.zvonix.test',
  client: 'client@e2e.zvonix.test',
  partner: 'partner@e2e.zvonix.test',
  /** Служба такси, у которой есть и свои SIM: один вход, два кабинета (ADR-0052). */
  both: 'both@e2e.zvonix.test',
} as const;

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Адрес почты').fill(email);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.getByRole('button', { name: 'Войти' }).click();
  // Вход завершён, когда страница входа сменилась: у каждой роли свой первый раздел.
  await expect(page).not.toHaveURL(/\/login/u);
}

test.describe('вход', () => {
  test('неверный пароль не пускает и говорит об этом', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Адрес почты').fill(PEOPLE.admin);
    await page.getByLabel('Пароль').fill('не-тот-пароль-совсем');
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('Неверный адрес или пароль')).toBeVisible();
    await expect(page).toHaveURL(/\/login/u);
  });

  test('сессия живёт в cookie, недоступной сценарию', async ({ page, context }) => {
    await signIn(page, PEOPLE.admin);

    const session = (await context.cookies()).find((cookie) => cookie.name.includes('zvonix'));
    expect(session, 'cookie сессии не выдана').toBeDefined();
    // `HttpOnly` — то, ради чего сессию и унесли из хранилища браузера: украденный
    // сценарий не должен уметь её прочитать (ADR-0037).
    expect(session?.httpOnly).toBe(true);

    // И проверка с другой стороны: из страницы её действительно не видно.
    expect(await page.evaluate(() => document.cookie)).not.toContain('zvonix');
  });

  test('выход возвращает на страницу входа', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.getByRole('button', { name: 'Выйти' }).click();
    await expect(page).toHaveURL(/\/login/u);
  });
});

test.describe('разводка по ролям', () => {
  const homes: [keyof typeof PEOPLE, RegExp][] = [
    ['admin', /\/calls$/u],
    ['support', /\/calls$/u],
    ['client', /\/my\/calls$/u],
    ['partner', /\/partner\/calls$/u],
  ];

  for (const [role, home] of homes) {
    test(`${role} попадает в свой первый раздел`, async ({ page }) => {
      await signIn(page, PEOPLE[role]);
      await expect(page).toHaveURL(home);
    });
  }
});

test.describe('один вход — два кабинета', () => {
  test('переключатель в шапке ведёт в другой кабинет, меню меняется вместе с ним', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.both);
    await expect(page).toHaveURL(/\/my\/calls$/u);

    const switcher = page.getByRole('navigation', { name: 'Кабинет' });
    await switcher.getByRole('link', { name: 'Партнёр' }).click();
    await expect(page).toHaveURL(/\/partner\/calls$/u);
    await expect(switcher.getByText('Партнёр')).toHaveAttribute('aria-current', 'page');

    const rail = page.getByRole('navigation', { name: 'Разделы' });
    await expect(rail.getByRole('link', { name: 'Моё оборудование' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Мои линии' })).toHaveCount(0);
  });

  test('у кого кабинет один, переключателя нет, а в меню — заявка на второй', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await expect(page.getByRole('navigation', { name: 'Кабинет' })).toHaveCount(0);
    await page.getByRole('link', { name: 'Стать партнёром' }).click();
    await expect(page.getByRole('heading', { name: 'Заявка: кабинет партнёра' })).toBeVisible();
  });
});

test.describe('заявки', () => {
  test('регистрация отправляет заявку и говорит, что дальше', async ({ page }) => {
    await page.goto('/register');
    await page.getByRole('button', { name: /Партнёр/u }).click();
    await page.getByLabel('Ваше имя').fill('Орлов Максим');
    await page.getByLabel('Почта — она же логин').fill('orlov@e2e.zvonix.test');
    await page.getByLabel('Пароль').fill('очень-длинный-пароль');
    await page.getByLabel('Регион, где стоят шлюзы').fill('Пермский край');
    await page.getByRole('button', { name: 'МТС' }).click();
    await page.getByLabel('Телефон').fill('+7 902 111-22-33');
    await page.getByLabel(/Согласен/u).check();
    await page.getByRole('button', { name: 'Отправить заявку' }).click();

    await expect(page.getByRole('heading', { name: 'Заявка отправлена' })).toBeVisible();
  });

  test('администратор одобряет партнёра окном с псевдонимом', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/applications');
    const row = page.getByRole('row', { name: /Смирнов Олег Петрович/u });
    await row.getByRole('button', { name: 'Одобрить' }).click();

    const dialog = page.getByRole('alertdialog');
    await dialog.getByLabel('Псевдоним для клиентов').fill('Партнёр 40');
    await dialog.getByRole('button', { name: 'Одобрить и открыть кабинет' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('row', { name: /Смирнов Олег Петрович/u })).toHaveCount(0);
  });

  test('без подтверждённой почты одобрить нельзя, и экран говорит почему', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/applications');
    const row = page.getByRole('row', { name: /Кузнецова Мария/u });
    await expect(row.getByText('почта не подтверждена — одобрить пока нельзя')).toBeVisible();
    await expect(row.getByRole('button', { name: 'Одобрить' })).toBeDisabled();
  });

  test('письмо не дошло — администратор подтверждает адрес вручную, и одобрить можно', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/applications');
    const row = page.getByRole('row', { name: /Кузнецова Мария/u });
    await row.getByRole('button', { name: 'Подтвердить почту' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('журнал');
    await dialog.getByRole('button', { name: 'Подтвердить адрес' }).click();

    await expect(row.getByText('почта не подтверждена — одобрить пока нельзя')).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Одобрить' })).toBeEnabled();
  });
});

test.describe('кабинета ещё нет', () => {
  test('экран говорит, где заявка и что осталось сделать самому', async ({ page }) => {
    // Раньше здесь была одна фраза «кабинетов пока нет», а в меню — «Второй кабинет».
    await signIn(page, 'waiting@e2e.zvonix.test');
    await expect(
      page.getByRole('heading', { name: 'Заявка на кабинет партнёра на проверке' }),
    ).toBeVisible();
    await expect(page.getByText(/Подтвердите адрес/u)).toBeVisible();
    await page.getByRole('button', { name: 'Прислать письмо ещё раз' }).click();
    await expect(page.getByText(/Письмо отправлено ещё раз/u)).toBeVisible();

    const rail = page.getByRole('navigation', { name: 'Разделы' });
    await expect(rail.getByText('Второй кабинет')).toHaveCount(0);
    await expect(rail.getByRole('link', { name: 'Моя заявка' })).toBeVisible();
    // Имя в углу меню: кабинет читал `fullName`, а API отдаёт `full_name`.
    await expect(rail.getByText('Соколов Андрей')).toBeVisible();
  });
});

test.describe('версия выпуска в углу панели', () => {
  // Стенд собран не из выпуска: файла RELEASE нет, и кабинет так и говорит, а не выдумывает.
  test('администратор её видит', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    const rail = page.getByRole('navigation', { name: 'Разделы' });
    await expect(rail.getByText('сборка не из выпуска')).toBeVisible();
  });

  test('клиент — нет: номер выпуска подсказывает, какие уязвимости пробовать', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    const rail = page.getByRole('navigation', { name: 'Разделы' });
    // Панель рисуется после ответа о сессии; клиенту запрос версии не делается вовсе,
    // так что после её появления ждать больше нечего.
    await expect(rail).toBeVisible();
    await expect(rail.getByText(/сборка не из выпуска|^версия /u)).toHaveCount(0);
  });
});

test.describe('поддержка видит, но не меняет', () => {
  test('разделы открыты — включая те, что раньше были закрыты целиком', async ({ page }) => {
    await signIn(page, PEOPLE.support);

    const rail = page.getByRole('navigation', { name: 'Разделы' });
    for (const label of [
      'Учётные записи',
      'Партнёры и оборудование',
      'Клиенты и деньги',
      'Тарифы и наценка',
      'Разбор вызовов',
    ]) {
      await expect(rail.getByRole('link', { name: label })).toBeVisible();
    }

    // Настройки площадки закрыты и останутся: там секреты, и обработчик чтения
    // у них помечен ролью администратора (ADR-0041 к этому отношения не имеет).
    await expect(rail.getByRole('link', { name: 'Настройки площадки' })).toHaveCount(0);
  });

  test('на партнёрах нет действий, но есть данные и отметка «только чтение»', async ({ page }) => {
    await signIn(page, PEOPLE.support);
    await page.goto('/partners');

    await expect(page.getByText('Только чтение:')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить партнёра' })).toHaveCount(0);
    // Данные при этом на месте: раздел открыт целиком, а не наполовину.
    await expect(page.getByText('Иванов Иван Иванович')).toBeVisible();
  });

  test('администратор на том же экране действие видит', async ({ page }) => {
    // Обратная половина: если бы кнопки не было ни у кого, предыдущая проверка
    // проходила бы и на сломанном экране.
    await signIn(page, PEOPLE.admin);
    await page.goto('/partners');

    await expect(page.getByRole('button', { name: 'Добавить партнёра' })).toBeVisible();
    await expect(page.getByText('Только чтение:')).toHaveCount(0);
  });
});

test.describe('чужой раздел', () => {
  test('клиент, зайдя в админский раздел, видит объяснение, а не пустоту', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/partners');

    // По тексту, а не по роли: Next держит на странице собственный объявитель
    // маршрута с той же ролью `alert`, и отбор по роли находит оба.
    await expect(page.getByText('Раздел доступен')).toBeVisible();
  });

  test('партнёр видит свои разделы и своё состояние', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/money');

    // Заголовок, а не любой текст: то же имя стоит в углу меню, как только загрузится сессия.
    await expect(page.getByRole('heading', { name: 'Иванов Иван Иванович' })).toBeVisible();
    await expect(page.getByText('Партнёр 17')).toBeVisible();
    // Заработка ещё нет, и это нормальное состояние нового партнёра.
    await expect(page.getByText('Заработано, к выплате')).toBeVisible();
  });
});

test.describe('кабинет клиента', () => {
  test('свои линии перечисляются — до этого их взять было неоткуда', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/channels');

    await expect(page.getByText('Диспетчерская')).toBeVisible();
  });
});

test.describe('ввод денег', () => {
  // Меняет состояние стенда — поэтому после проверок, которые только читают.
  test('копейки набираются запятой — той же, с какой кабинет их показывает', async ({ page }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/tariffs');

    await page.getByRole('button', { name: 'Добавить правило' }).click();
    await page.getByLabel('Доля, %').fill('5');
    await page.getByLabel('Фикс за вызов, ₽').fill('0,1');
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();

    // Правило без клиента ложится на всех, у кого нет своего, — окно говорит это до нажатия.
    // Раньше заранее заполненная форма заводила наценку на всю площадку с первого щелчка.
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toContainText('для всех клиентов');
    await dialog.getByRole('button', { name: 'Добавить правило' }).click();
    await expect(dialog).toHaveCount(0);

    // Десять копеек, а не рубль и не отказ проверки: перевод в машинный вид —
    // работа кабинета, а не человека.
    await expect(page.getByRole('table').getByText(/0,1/u)).toBeVisible();
  });
});

test.describe('клиент заводит доступ своей системе', () => {
  test('секрет ключа приходит там же, где его вставят в диспетчерскую', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/integration');

    // До ADR-0044 ключ выпускал администратор, и секрет обязан был дойти до клиента
    // перепиской. Теперь он появляется там же, где его и вставляют.
    await page.getByRole('button', { name: 'Создать ключ' }).click();
    await page.getByLabel('Назначение').fill('Диспетчерская на проверке');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Создать и показать секрет' })
      .click();

    await expect(page.getByText('Ключ «Диспетчерская на проверке»')).toBeVisible();
    await expect(page.getByText(/zvx_client_/u).first()).toBeVisible();
  });

  test('отзыв спрашивает и отменяется: ключ после него не оживить', async ({ page }) => {
    await signIn(page, PEOPLE.client);
    await page.goto('/my/integration');

    await page.getByRole('button', { name: 'Создать ключ' }).click();
    await page.getByLabel('Назначение').fill('Ключ на отзыв');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Создать и показать секрет' })
      .click();
    await expect(page.getByText('Ключ «Ключ на отзыв»')).toBeVisible();

    const row = page.getByRole('row').filter({ hasText: 'Ключ на отзыв' });
    const dialog = page.getByRole('alertdialog', { name: 'Отозвать ключ «Ключ на отзыв»' });

    // Escape отменяет, и ключ жив. Прежняя взведённая кнопка «Точно отозвать?»
    // не сбрасывалась ничем, и следующий щелчок отзывал ключ уже без вопроса.
    await row.getByRole('button', { name: 'Отозвать' }).click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(row.getByText(/отозван/u)).toHaveCount(0);

    await row.getByRole('button', { name: 'Отозвать' }).click();
    await dialog.getByRole('button', { name: 'Отозвать ключ' }).click();

    await expect(dialog).toHaveCount(0);
    await expect(row.getByText(/отозван/u)).toBeVisible();
    // Кнопки «Отозвать» у ключа больше нет, но фокус не падает на страницу (ConfirmAction).
    await expect
      .poll(() => page.evaluate(() => document.activeElement === document.body))
      .toBe(false);
  });
});

/** Подтвердить действие в окне, которое называет последствие, — кнопкой с тем же именем. */
async function confirmAction(page: Page, action: string): Promise<void> {
  await page.getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: action, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('партнёр добавляет своё оборудование', () => {
  test('шлюз добавляется с портами, настройки подключения видны на его странице', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP на проверке');
    await page.getByLabel('Слотов под SIM').fill('4');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();

    // Пароли линий показываются один раз, а шлюз встаёт строкой в общую таблицу.
    await expect(page.getByText('Входы линий шлюза «GOIP на проверке»')).toBeVisible();
    await expect(page.getByRole('region', { name: 'GOIP на проверке', exact: true })).toContainText(
      'карт 0 из 4',
    );

    await page.getByRole('link', { name: /Открыть шлюз/u }).click();
    await expect(
      page.getByRole('heading', { name: 'GOIP на проверке', exact: true }),
    ).toBeVisible();

    // Сервер, порт и режим видны всегда: раньше — только в минуту добавления.
    const connection = page.getByRole('region', { name: 'Подключение' });
    await expect(connection).toContainText('5060');
    await expect(connection).toContainText('Config by Line');

    // Указали четыре слота — четыре порта, а не «портов не заведено».
    const ports = page.getByRole('region', { name: 'Порты' });
    await expect(ports.getByRole('button', { name: 'Вставить SIM' })).toHaveCount(4);
  });

  test('SIM вставляется в порт по номеру, оператора не спрашивают', async ({ page }) => {
    const denied: string[] = [];
    page.on('response', (response) => {
      if (response.status() === 403) denied.push(response.url());
    });

    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз под карту');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('link', { name: 'Шлюз под карту' }).click();

    await page.getByRole('button', { name: 'Вставить SIM' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Оператор')).toHaveCount(0);
    await dialog.getByLabel('Номер карты').fill('+7 913 555-00-17');
    await dialog.getByRole('button', { name: 'Вставить' }).click();

    // Источника оператора на стенде нет: площадка честно говорит, что определить
    // не смогла, а не заводит карту с выдуманным оператором.
    await expect(dialog.getByText('Не удалось определить оператора номера')).toBeVisible();
    expect(denied).toEqual([]);
  });

  test('шлюз включается одной прямой кнопкой и так же возвращается после выключения', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз на выключение');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('link', { name: 'Шлюз на выключение' }).click();

    // Невключённый шлюз не пускают даже с верными настройками — и страница говорит это прямо.
    // Раньше включение пряталось в окне за кнопкой «Состояние» (владелец, 2026-09-25).
    await expect(page.getByText('Не включён', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(/Шлюз не включён — линии не могут подключиться/u)).toBeVisible();
    await page.getByRole('button', { name: 'Включить шлюз' }).click();
    await expect(page.getByText('Работает', { exact: true })).toBeVisible();

    // До ADR-0047 выключение партнёра не отличалось от отключения площадкой,
    // и за одной кнопкой «Включить» приходилось идти к администратору.
    await confirmAction(page, 'Выключить шлюз');
    await expect(page.getByText('Выключен вами')).toBeVisible();
    await page.getByRole('button', { name: 'Включить шлюз' }).click();
    await expect(page.getByText('Работает', { exact: true })).toBeVisible();
  });

  test('удаление называет последствие до нажатия и уводит шлюз из списка', async ({ page }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');

    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('Шлюз на удаление');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('link', { name: 'Шлюз на удаление' }).click();

    await page.getByRole('button', { name: 'Удалить шлюз' }).click();
    const dialog = page.getByRole('alertdialog');
    // Окно называет последствие, а не «вы уверены?»: удаление стоит рядом с «выключить»,
    // которое отменяется одним нажатием, и разница должна быть видна до нажатия.
    await expect(dialog).toContainText('навсегда');
    await dialog.getByRole('button', { name: 'Удалить навсегда' }).click();

    await expect(page.getByText(/Такого шлюза нет/u)).toBeVisible();
    await page.getByRole('link', { name: '← Всё оборудование' }).click();
    await expect(page.getByRole('row', { name: /Шлюз на удаление/u })).toHaveCount(0);
  });
});

test.describe('операторы связи (ADR-0053)', () => {
  test('администратор подтверждает оператора номера вручную, и номер становится рабочим', async ({
    page,
  }) => {
    // Служба проверки перенесённых номеров с сервера недоступна, а без подтверждения
    // по номеру не звонят вовсе. Человек, проверивший номер, — подтверждение.
    await signIn(page, PEOPLE.admin);
    await page.goto('/operators');

    await page.getByLabel('Номер', { exact: true }).fill('+7 913 555-44-33');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(
      page.getByText('Оператор не подтверждён — по этому номеру не звонят.'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Подтвердить оператора вручную' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('журнал');
    await dialog.getByLabel('Оператор').selectOption({ label: 'МегаФон' });
    await dialog.getByRole('button', { name: 'Подтвердить оператора' }).click();

    await expect(page.getByText('Оператор подтверждён — по номеру звонят.')).toBeVisible();
    await expect(page.getByText('подтверждён администратором')).toBeVisible();
  });

  test('поддержка видит справочник и проверку номера, но не подтверждает', async ({ page }) => {
    await signIn(page, PEOPLE.support);
    await page.goto('/operators');

    await expect(page.getByText('Только чтение:')).toBeVisible();
    await page.getByLabel('Номер', { exact: true }).fill('+7 913 555-44-34');
    await page.getByRole('button', { name: 'Проверить' }).click();
    await expect(page.getByText(/Оператор не подтверждён/u)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Подтвердить оператора вручную' })).toHaveCount(
      0,
    );
  });

  test('партнёр видит префикс каждой линии и что ввести в GOIP', async ({ page }) => {
    // Без префикса GOIP сам выбирал линию, и вызов на МТС мог уйти с SIM T2.
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP с префиксами');
    await page.getByLabel('Подключение').selectOption({ label: 'Весь шлюз одним входом' });
    await page.getByLabel('Слотов под SIM').fill('2');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('link', { name: 'GOIP с префиксами' }).click();

    const connection = page.getByRole('region', { name: 'Подключение' });
    await expect(connection).toContainText('Single Server Mode');
    await expect(connection).toContainText('Match Callee');
    const ports = page.getByRole('region', { name: 'Порты' });
    await expect(ports.getByRole('row', { name: /^1 префикс 99001/u })).toBeVisible();
    await expect(ports.getByRole('row', { name: /^2 префикс 99002/u })).toBeVisible();
  });
});

test.describe('оборудование одной таблицей, вход по линиям (ADR-0054)', () => {
  test('карты всех шлюзов видны в общей таблице, шлюз сворачивается', async ({ page }) => {
    // Раньше карты были только на странице каждого шлюза, и найти, где стоит номер,
    // можно было, лишь заходя во все по очереди (владелец, 2026-09-25).
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP в общей таблице');
    await page.getByLabel('Слотов под SIM').fill('3');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('button', { name: 'Записал, закрыть' }).click();

    const group = page.getByRole('region', { name: 'GOIP в общей таблице', exact: true });
    await expect(group.getByRole('button', { name: 'Вставить SIM' })).toHaveCount(3);

    await group
      .getByRole('button', { name: 'Свернуть порты шлюза «GOIP в общей таблице»' })
      .click();
    await expect(group.getByRole('button', { name: 'Вставить SIM' })).toHaveCount(0);
    await group
      .getByRole('button', { name: 'Раскрыть порты шлюза «GOIP в общей таблице»' })
      .click();
    await expect(group.getByRole('button', { name: 'Вставить SIM' })).toHaveCount(3);
  });

  test('у каждой линии свой логин, пароли показывают один раз; можно перейти на один вход', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP по линиям');
    await expect(page.getByLabel('Подключение')).toHaveValue('port');
    await page.getByLabel('Слотов под SIM').fill('2');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();

    const secrets = page.getByRole('region', { name: 'Входы линий шлюза «GOIP по линиям»' });
    await expect(secrets.getByRole('row', { name: /^Line 1 pt-/u })).toBeVisible();
    await expect(secrets.getByRole('row', { name: /^Line 2 pt-/u })).toBeVisible();

    await page.getByRole('link', { name: 'Открыть шлюз — порты и настройки →' }).click();
    // Настройки — построчно для каждой линии, теми же полями, что у линии в GOIP.
    const lines = page.getByRole('table', { name: 'Настройки линий' });
    // Префикс линии — в строке: без Routing Prefix GOIP ждёт тонового набора (2026-09-29).
    await expect(lines.getByRole('row', { name: /^Line 1 pt-/u })).toContainText('99001');
    await expect(lines.getByRole('row', { name: /^Line 2 pt-/u })).toContainText('не на связи');
    const ports = page.getByRole('region', { name: 'Порты' });

    await page.getByRole('button', { name: 'Перейти на один вход для шлюза' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Перейти на один вход для шлюза' })
      .click();
    const connection = page.getByRole('region', { name: 'Подключение' });
    await expect(connection).toContainText('Single Server Mode');
    await expect(ports.getByRole('row', { name: /^1 префикс 99001/u })).toBeVisible();
  });

  test('тестовый звонок с карты: окно с номером и понятный отказ, пока линия не на связи', async ({
    page,
  }) => {
    // ADR-0055. Живого FreeSWITCH на стенде нет — проверяется путь до узла: кнопка у карты,
    // окно, отказ словами партнёра, а не кодом.
    await signIn(page, PEOPLE.partner);
    await page.goto('/partner/equipment');
    await page.getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByLabel('Название').fill('GOIP для пробы');
    await page.getByLabel('Слотов под SIM').fill('1');
    await page.getByRole('dialog').getByRole('button', { name: 'Добавить шлюз' }).click();
    await page.getByRole('button', { name: 'Записал, закрыть' }).click();

    // Источника оператора на стенде нет, и по номеру карта не заводится (см. «SIM вставляется
    // в порт по номеру…»). Карта заводится с явным оператором стенда и вставляется из вынутых.
    const operators = await page.request.get('/api/operators', {
      headers: { 'X-Zvonix-Web': '1' },
    });
    const operator = (await operators.json()) as { operators: { id: string; name: string }[] };
    const megafon = operator.operators.find((row) => row.name === 'МегаФон');
    expect(megafon).toBeDefined();
    const created = await page.request.post('/api/partner/sim-cards', {
      headers: { 'X-Zvonix-Web': '1' },
      data: { msisdn: '+7 913 555-00-01', operatorId: megafon?.id },
    });
    expect(created.status()).toBe(201);
    await page.reload();

    const group = page.getByRole('region', { name: 'GOIP для пробы', exact: true });
    await group.getByRole('button', { name: 'Вставить SIM' }).click();
    const insert = page.getByRole('dialog');
    await insert.getByRole('combobox').selectOption({ label: '79135550001 · МегаФон' });
    await insert.getByRole('button', { name: 'Вставить' }).click();

    await group.getByRole('button', { name: 'Тестовый звонок' }).click();
    const dialog = page.getByRole('dialog', { name: 'Тестовый звонок' });
    await dialog.getByLabel('Куда звонить').fill('+7 913 000-11-22');
    await dialog.getByRole('button', { name: 'Позвонить' }).click();
    await expect(dialog).toContainText('Линия ещё не подключилась к площадке');
  });
});

test.describe('список, который заменяется целиком', () => {
  test('регион покрытия не добавить, пока список не пришёл: форма стёрла бы прежние', async ({
    page,
  }) => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Ответ со списком придерживается. Форма, работавшая до него, отправляла
    // `[новый регион]`, и API заменял им весь список (ui-review, 2026-09-14).
    await page.route(/\/partners\/[^/]+\/coverage$/u, async (route) => {
      if (route.request().method() === 'GET') await held;
      await route.continue();
    });

    await signIn(page, PEOPLE.admin);
    await page.goto('/partners');
    await page
      .getByRole('row')
      .filter({ hasText: 'Иванов Иван Иванович' })
      .getByRole('link', { name: /Открыть/u })
      .click();

    await expect(page.getByText('Загружаем покрытие…')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить регион' })).toHaveCount(0);
    // И не «список пуст — берёт любой регион»: до ответа это неправда.
    await expect(page.getByText('Список пуст')).toHaveCount(0);

    release();
    await expect(page.getByRole('button', { name: 'Добавить регион' })).toBeVisible();
  });
});

test.describe('учётные записи', () => {
  test('свою запись администратор не закрывает: вернуть его смог бы только другой', async ({
    page,
  }) => {
    await signIn(page, PEOPLE.admin);
    await page.goto('/users');

    const own = page.getByRole('row').filter({ hasText: PEOPLE.admin });
    await expect(own.getByText('ваша запись')).toBeVisible();
    await expect(own.getByRole('button', { name: 'Изменить' })).toHaveCount(0);

    // Обратная половина: у чужой записи выбор есть, иначе проверка прошла бы и на пустом экране.
    const other = page.getByRole('row').filter({ hasText: PEOPLE.support });
    await expect(other.getByRole('button', { name: 'Изменить' })).toBeVisible();
  });
});

test.describe('таблица шире экрана', () => {
  // Без фокуса прокручиваемый вбок блок недоступен с клавиатуры — правую часть таблицы
  // без мыши не увидеть (axe `scrollable-region-focusable`, `pnpm ui:screens` 2026-09-22).
  test.describe('телефон', () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test('прокручиваемая таблица берёт фокус и называет себя', async ({ page }) => {
      await signIn(page, PEOPLE.admin);
      await page.goto('/users');

      const table = page.locator('[data-slot="table-container"]').first();
      await expect(table).toHaveAttribute('tabindex', '0');
      await expect(table).toHaveAttribute('role', 'region');
      await table.focus();
      await expect(table).toBeFocused();
    });
  });

  test.describe('широкий экран', () => {
    // 1920, а не 1280: на 1280 таблица учётных записей шире места и столбец действий
    // уходит за край (замер 2026-09-22) — там фокус как раз нужен.
    test.use({ viewport: { width: 1920, height: 1080 } });

    test('та же таблица, поместившись, лишней остановки Tab не добавляет', async ({ page }) => {
      // Обратная половина: фокус нужен только прокручиваемому блоку, иначе каждая таблица
      // стала бы лишним нажатием Tab.
      await signIn(page, PEOPLE.admin);
      await page.goto('/users');

      const table = page.locator('[data-slot="table-container"]').first();
      await expect(page.getByRole('row').filter({ hasText: PEOPLE.support })).toBeVisible();
      await expect(table).not.toHaveAttribute('tabindex', '0');
    });
  });
});

test.describe('ссылки из писем', () => {
  // Страниц не было: письмо с подтверждением адреса уходило, а ссылка из него вела
  // на 404 (владелец, 2026-09-23). Выдуманный код доходит до API и получает его отказ —
  // значит, страница есть и спрашивает нужный обработчик.
  test('подтверждение адреса: страница есть и говорит, что ссылка устарела', async ({ page }) => {
    await page.goto('/confirm-email?token=vydumannyy-kod-dlya-proverki');
    await expect(page.getByRole('heading', { name: 'Подтверждение адреса' })).toBeVisible();
    await expect(page.getByText(/Ссылка недействительна/u)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Перейти ко входу' })).toBeVisible();
  });

  test('подтверждение без кода в ссылке объясняет, что ссылку обрезали', async ({ page }) => {
    await page.goto('/confirm-email');
    await expect(page.getByText(/нет кода подтверждения/u)).toBeVisible();
  });

  test('обрезанная почтовой программой ссылка — «недействительна», а не отказ проверки', async ({
    page,
  }) => {
    await page.goto('/confirm-email?token=abc');
    await expect(page.getByText(/Ссылка недействительна/u)).toBeVisible();
    await expect(page.getByText('Данные запроса не прошли проверку')).toHaveCount(0);
  });

  test('новый пароль: несовпадение видно до отправки, устаревшая ссылка — после', async ({
    page,
  }) => {
    await page.goto('/reset-password?token=vydumannyy-kod-dlya-proverki');
    await page.getByLabel('Новый пароль').fill('Новый-пароль-2026');
    await page.getByLabel('Ещё раз').fill('Другой-пароль-2026');
    await expect(page.getByText('Пароли не совпадают')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Сохранить пароль' })).toBeDisabled();

    await page.getByLabel('Ещё раз').fill('Новый-пароль-2026');
    await page.getByRole('button', { name: 'Сохранить пароль' }).click();
    await expect(page.getByText(/Ссылка недействительна/u)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Запросить новую ссылку' })).toBeVisible();
  });

  test('«Забыли пароль?» со входа ведёт к заявке, ответ не выдаёт, есть ли адрес', async ({
    page,
  }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: 'Забыли пароль?' }).click();
    await expect(page).toHaveURL(/\/forgot-password$/u);
    await page.getByLabel('Адрес почты').fill('nikogo-net@e2e.zvonix.test');
    await page.getByRole('button', { name: 'Прислать ссылку' }).click();
    await expect(page.getByRole('heading', { name: 'Проверьте почту' })).toBeVisible();
    await expect(page.getByText(/Если адрес/u)).toBeVisible();
  });

  test('вход без подтверждённой почты объясняет, что делать, и присылает письмо заново', async ({
    page,
  }) => {
    // Человек с истёкшей ссылкой видел только «не активирована» и ждал администратора,
    // а войти, чтобы попросить новое письмо, не мог (владелец, 2026-09-23). Своя запись:
    // заявки из наполнения стенда меняют соседние тесты.
    const email = `resend-${String(Date.now())}@e2e.zvonix.test`;
    const registered = await page.request.post('/api/auth/register', {
      data: {
        email,
        password: PASSWORD,
        fullName: 'Лебедев Игорь',
        cabinet: 'client',
        answers: { companyName: 'Такси «Запад»', city: 'Пермь', phone: '+7 342 000-00-00' },
      },
    });
    expect(registered.status()).toBe(202);

    await page.goto('/login');
    await page.getByLabel('Адрес почты').fill(email);
    await page.getByLabel('Пароль').fill(PASSWORD);
    await page.getByRole('button', { name: 'Войти' }).click();

    await expect(page.getByText('Адрес почты не подтверждён.')).toBeVisible();
    await page.getByRole('button', { name: 'Прислать письмо ещё раз' }).click();
    await expect(page.getByText(/Письмо ушло на/u)).toBeVisible();
  });
});

test.describe('первый запуск', () => {
  // ADR-0050. На стенде администратор заведён — живьём проверяется закрытая дверь.
  // Открытая — подменой ответов API в браузере: логику заведения проверяют тесты с базой,
  // а здесь — что кабинет ведёт человека верно.
  test('с заведённым администратором страница говорит «уже выполнен», а вход остаётся входом', async ({
    page,
  }) => {
    await page.goto('/setup');
    await expect(page.getByText('Первый запуск уже выполнен')).toBeVisible();
    await page.getByRole('link', { name: 'Ко входу' }).click();
    await expect(page).toHaveURL(/\/login$/u);
    await expect(page.getByRole('button', { name: 'Войти' })).toBeVisible();
  });

  test('без администратора вход ведёт на первый запуск, и форма доводит до входа', async ({
    page,
  }) => {
    let posted = 0;
    let created = false;
    await page.route('**/api/setup', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({ json: { required: !created } });
        return;
      }
      posted += 1;
      const body = route.request().postDataJSON() as { code: string };
      if (body.code !== 'B4PR-3N3H-CCP5') {
        await route.fulfill({
          status: 400,
          json: {
            error: {
              code: 'validation_failed',
              message: 'Код первого запуска не подходит',
              details: { problems: ['code: не подходит'] },
            },
          },
        });
        return;
      }
      created = true;
      await route.fulfill({ status: 201, json: { user: { id: 'x', role: 'admin' } } });
    });

    await page.goto('/login');
    await expect(page).toHaveURL(/\/setup$/u);

    await page.getByLabel('Код первого запуска').fill('AAAA-AAAA-AAAA');
    await page.getByLabel('Адрес почты администратора').fill('owner@example.test');
    await page.getByLabel('Имя').fill('Владелец Площадки');
    await page.getByLabel('Пароль — не короче 12 знаков').fill('достаточно длинный пароль');
    await page.getByLabel('Пароль ещё раз').fill('другой длинный пароль');
    await page.getByRole('button', { name: 'Создать администратора' }).click();
    // Несовпадение ловится до отправки: опечатка в пароле единственного администратора
    // запирает площадку.
    await expect(page.getByText('Пароли не совпадают')).toBeVisible();
    expect(posted).toBe(0);

    await page.getByLabel('Пароль ещё раз').fill('достаточно длинный пароль');
    await page.getByRole('button', { name: 'Создать администратора' }).click();
    await expect(page.getByText('Код первого запуска не подходит')).toBeVisible();

    await page.getByLabel('Код первого запуска').fill('B4PR-3N3H-CCP5');
    await page.getByRole('button', { name: 'Создать администратора' }).click();
    await expect(page.getByText('Администратор создан')).toBeVisible();
    await page.getByRole('link', { name: 'Войти' }).click();
    await expect(page).toHaveURL(/\/login$/u);
  });
});
