import { Browser } from 'puppeteer';
import cheerio from 'cheerio';
import { Announcement } from '../types';
import l from '../logger';
import { DAY_MS, Urls } from '../constants';
import { config } from '../config';

let _debugInfo = { url: String(Urls.Olx), idx: 0 };

export async function getOlxAnnouncements(browser: Browser): Promise<Announcement[]> {
	const $firstPage = await getOlxPage(browser, Urls.Olx);
	const [firstPageAds, isDone] = await getOlxPageAds($firstPage);
	const announcements: Announcement[] = firstPageAds;

	if (isDone) {
		l.debug('[Olx] Scraping ended on the first page.');
		return announcements;
	}

	const pageUrls = getOlxUrlsToNextPages($firstPage);

	if (pageUrls.length === 0) {
		l.warn(
			'[Olx] There was only one page or the service was not able to read the links to the next pages.'
		);
		return announcements;
	}

	for (let i = 0; i < pageUrls.length; i++) {
		_debugInfo.url = pageUrls[i];
		const $page = await getOlxPage(browser, pageUrls[i]);
		const [pageAds, isDone] = await getOlxPageAds($page);
		announcements.push(...pageAds);
		if (isDone) {
			break;
		}
	}
	return announcements;
}

export function getOlxUrlsToNextPages($page: cheerio.Root) {
	const pagesUrls: string[] = [];
	// @i: the first page does not have link
	const pagesCount = $page('div.pager.rel.clr').find(
		'a.block.br3.brc8.large.tdnone.lheight24'
	).length;
	// @i: olx just add &page=num to url so there is no need to read links from the elements
	// @i: pages starts from 1, skip first page
	for (let i = 2; i < pagesCount; i++) {
		pagesUrls.push(Urls.Olx + '&page=' + i);
	}

	l.debug(`Olx pages number: ${pagesUrls.length} + 1 (first page).`);

	return pagesUrls;
}

export async function getOlxPage(browser: Browser, url: string): Promise<cheerio.Root> {
	const page = await browser.newPage();
	const response = await page.goto(url);
	if (!response || response.status() !== 200) {
		throw new Error(`Unable to load "${url}"`);
	}
	l.fatal('--', response.status());
	const content = await page.content();
	await page.close({ runBeforeUnload: false });
	const $page = cheerio.load(content);
	return $page;
}

export async function getOlxPageAds(
	$page: cheerio.Root
): Promise<[ads: Announcement[], isDone: boolean]> {
	const $ads = $page('table#offers_table').find('div.offer-wrapper>table');
	const now = Date.now();
	const [pageAds, isDone] = parseOlxPageAds($page, $ads);
	l.info('--parseOlxPageAnnouncements execution time:', Date.now() - now, 'ms');

	return [pageAds, isDone];
}

export function parseOlxPageAds(
	$page: cheerio.Root,
	$ads: cheerio.Cheerio
): [ads: Announcement[], isDone: boolean] {
	const announcements: Announcement[] = [];
	for (let i = 0, len = $ads.length; i < len; i++) {
		const announcement = {} as Announcement;
		const $ad = $page($ads[i]);

		const dt = $ad
			.find('.bottom-cell .breadcrumb.x-normal>span > [data-icon*="clock"]')
			.parent()
			.text();
		const parsedDate = parseOlxAdTime(dt);
		let adDate: string;

		if (typeof parsedDate === 'object') {
			let isTodayOrYesterday = /(dzisiaj|wczoraj)/.test(dt);
			// @i: now minus 24 hours with some padding (30s) for the program execution
			// @i: the padding also solves midnight dates.
			const currentDate = Date.now() - (DAY_MS + 1000 * 30);
			// @info: for "dziś/wczoraj" we got the ad's hour and min therefore we can determine if is older then 24h
			// @info: for other cases like "29 gru" the time will be 00:00, so some more hours will be included
			if (currentDate > parsedDate.getTime() - (isTodayOrYesterday ? 0 : DAY_MS)) {
				return [announcements, true];
			}

			adDate = parsedDate.toLocaleString(
				...(isTodayOrYesterday
					? config.dateTimeFormatParams
					: config.dateFormatParams)
			);
		} else {
			// @i: type string means that service was not able to get/parse date.
			adDate = parsedDate;
		}

		announcement.dt = adDate;
		const $titleLink = $ad.find('.title-cell a');
		announcement.title = $titleLink.text().replace(/[\n]/gi, '').trim();
		announcement.url = $titleLink.attr('href')!;
		let priceText = $ad.find('.td-price .price>strong').text();
		priceText = priceText.replace(/[^\d\.,]/gi, '').replace(/,/g, '.');
		if (isNaN(+priceText)) {
			l.debug(`[Olx] Price "${priceText}" is not a number.`, announcement.url);
		}
		announcement.price = priceText;

		const imgUrl = $ad.find('.photo-cell > a > img').attr('src')!;
		announcement.imgUrl = imgUrl;

		// @i: there is no description in ad card, it would require to open details to gen desc.
		announcement.description = '';
		_debugInfo.idx = i;
		announcement._debugInfo = { ..._debugInfo };
		announcements.push(announcement);
	}

	return [announcements, false];
}

export function parseOlxAdTime(olxTime: string): Date | string {
	const olxTimeArr = olxTime.split(' ').filter((x) => x !== '');
	if (olxTimeArr.length > 2) {
		l.silly('1.	returning default time:', olxTime);
		return olxTime;
	}

	if (olxTimeArr[0] === 'dzisiaj' || olxTimeArr[0] === 'wczoraj') {
		return parseOlxAdTimeWithTodayYesterday(olxTimeArr[0], olxTimeArr[1]);
	}

	return parseOlxAdDateWithMontPrefix(olxTimeArr[1], olxTimeArr[0]);
}

export function parseOlxAdDateWithMontPrefix(
	monthPrefix: string,
	day: string
): Date | string {
	// @i: in this case the "olxTime" will be like 29 gru
	// @i: so we just need to map the mont prefix to full name
	monthPrefix = monthPrefix.substr(0, 3); // @i: not sure if all moth are represented as 3 chars
	const currentDate = new Date();
	let dayNum = parseInt(day, 10);

	if (isNaN(dayNum) || +day !== dayNum) {
		l.silly('2.	returning default time:', day + ' ' + monthPrefix);
		return day + ' ' + monthPrefix;
	}

	let year = currentDate.getFullYear();
	const monthNum = mapMonthPrefixToMonth(monthPrefix, true) as number;
	if (monthNum === 11) {
		if (currentDate.getDate() < dayNum) {
			year = year - 1;
		}
	}

	const adDate = new Date(year, monthNum, dayNum);
	return adDate;
}

export function parseOlxAdTimeWithTodayYesterday(
	daySynonym: 'dzisiaj' | 'wczoraj',
	time: string
): Date | string {
	const timeArr = time.split(':');
	const hour = parseInt(timeArr[0], 10);
	const minutes = parseInt(timeArr[1], 10);
	if (
		isNaN(hour) ||
		isNaN(minutes) ||
		hour !== +timeArr[0] ||
		minutes !== +timeArr[1]
	) {
		l.silly('3.	returning default time:', daySynonym + ' ' + time);

		return daySynonym + ' ' + time;
	}

	const currentDate = new Date();
	const adDate = new Date(
		currentDate.getFullYear(),
		currentDate.getMonth(),
		currentDate.getDate() + (daySynonym === 'wczoraj' ? -1 : 0),
		hour,
		minutes
	);
	return adDate;
}

export function mapMonthPrefixToMonth(
	monthPrefix: string,
	asNumber: boolean = true
): string | number {
	switch (monthPrefix) {
		case 'sty':
			return asNumber ? 0 : 'styczeń';
		case 'lut':
			return asNumber ? 1 : 'luty';
		case 'mar':
			return asNumber ? 2 : 'marzec';
		case 'kwi':
			return asNumber ? 3 : 'kwiecień';
		case 'maj':
			return asNumber ? 4 : 'maj';
		case 'cze':
			return asNumber ? 5 : 'czerwiec';
		case 'lip':
			return asNumber ? 6 : 'lipiec';
		case 'sie':
			return asNumber ? 7 : 'sierpień';
		case 'wrz':
			return asNumber ? 8 : 'wrzesień';
		case 'paź':
		case 'paz':
			return asNumber ? 9 : 'październik';
		case 'lis':
			return asNumber ? 10 : 'listopad';
		case 'gru':
			return asNumber ? 11 : 'grudzień';
		default:
			throw new Error('Unrecognized month prefix');
	}
}
