import { Browser, Page } from 'puppeteer';
import path from 'path';
import l from '../logger';
import { IOffer, SiteName, OffersInfo } from '../types';
import cheerio from 'cheerio';
import { config } from '../config';
import { sleep } from '../sleep';
import { IScraper, ISiteScraper, ScraperDataType } from './types';
import { ensurePathExists } from '../files';
import { makeSiteScraper } from './siteScraperFactory';
import { formatDateToFileName } from '../formatDate';
import { writeFile } from 'fs/promises';
import { timeStart } from '../performance';

export class Scraper implements IScraper {
	async scrapeOffers(browser: Browser, sites: SiteName[]) {
		let siteIndex = 0;
		while (siteIndex < sites.length) {
			const promises: Promise<void>[] = [];
			l.info(`About to scrape: "${sites[siteIndex]}"`);
			promises.push(this.scrapeSiteOffers(browser, sites[siteIndex]));
			if (++siteIndex < sites.length) {
				l.info(`About to scrape: "${sites[siteIndex]}"`);
				promises.push(this.scrapeSiteOffers(browser, sites[siteIndex]));
			}
			siteIndex++;
			// @info: scrape up to two sites at a time.
			await Promise.all(promises);
		}
	}

	private async scrapeSiteOffers(browser: Browser, siteName: SiteName) {
		const siteScraper = makeSiteScraper(siteName);
		// @todo: handle error
		const [todayOffers, error] = await this.getSiteOffers(browser, siteScraper);

		await this.saveSiteOffers(siteScraper.serviceName, {
			date: new Date(),
			offers: todayOffers
		});
		this.validateOffers(todayOffers, siteScraper.serviceName);

		l.info(
			`The number of today's "${siteScraper.serviceName}" offers is: `,
			todayOffers.length
		);
	}

	private async saveSiteOffers(siteName: SiteName, dataToSave: OffersInfo) {
		const dirPath = path.resolve(__dirname, '..', '..', 'data', siteName);
		const pathName = path.join(dirPath, `${formatDateToFileName()}.json`);
		const text = JSON.stringify(dataToSave, null, config.isDev ? '\t' : 0);
		try {
			await ensurePathExists(dirPath);
			l.info(`About to save the ${siteName} offers to "${pathName}".`);
			await writeFile(pathName, text);
		} catch (err) {
			l.error(`Fail to save the ${siteName} offers to the file.`, err);
			throw err;
		}
	}

	private async getSiteOffers(
		browser: Browser,
		siteScraper: ISiteScraper
	): Promise<[IOffer[], Error | null]> {
		const offers: IOffer[] = [];
		const pageUrls: string[] = [config.urls[siteScraper.serviceName]];
		let isDone = false;
		let scrapedPagesCount = 0;
		do {
			let pageOffers: IOffer[];
			let currentPage: Page;
			const url = pageUrls[0];

			siteScraper._debugInfo.url = url;
			try {
				currentPage = await this.getPage(browser, url, siteScraper);
			} catch (err) {
				return [offers, err];
			}
			const $currentPage: cheerio.Root = await this.getPageContent(currentPage);

			[pageOffers, isDone] = await this.getScraperPageAds(
				siteScraper,
				$currentPage,
				currentPage
			);
			offers.push(...pageOffers);
			scrapedPagesCount++;
			pageUrls.shift();
			if (isDone === false && scrapedPagesCount === 1) {
				pageUrls.push(
					...(siteScraper.scrapperDataType === ScraperDataType.Html
						? siteScraper.getUrlsToNextPages($currentPage)
						: siteScraper.getUrlsToNextPages(url))
				);
			}
		} while (isDone === false && pageUrls.length > 0);

		l.info(`[${siteScraper.serviceName}] Scraped pages count: ${scrapedPagesCount}.`);

		return [offers, null];
	}

	private async getScraperPageAds(
		siteScraper: ISiteScraper,
		$currentPage: cheerio.Root,
		currentPage: Page
	): Promise<[ads: IOffer[], isDone: boolean]> {
		if (siteScraper.scrapperDataType === ScraperDataType.Html) {
			return siteScraper.getPageAds($currentPage);
		}
		return siteScraper.getPageAds(currentPage);
	}

	private async getPage(
		browser: Browser,
		url: string,
		siteScraper: ISiteScraper
	): Promise<Page> {
		let retries = 0;
		const startTime = Date.now();
		do {
			try {
				const page = await this.loadPage(browser, url, siteScraper);
				return page;
			} catch (err) {
				if (Date.now() - startTime > config.scrapeSiteTimeout) {
					new Error(
						`[${siteScraper.serviceName}] Scraping exceeded ${config.scrapeSiteTimeout} min.`
					);
				}
				retries++;
				const timeout = (retries < 15 ? retries : 15) * 1000;
				l.debug(
					`[${siteScraper.serviceName}] Setting retry #${retries} timeout: ${timeout}.`
				);
				await sleep(timeout);
			}
		} while (true);
	}

	private async loadPage(
		browser: Browser,
		url: string,
		siteScraper: ISiteScraper
	): Promise<Page> {
		let timeStop = timeStart();
		const page = await browser.newPage();
		timeStop(`[${siteScraper!.serviceName}] browser.newPage`);

		try {
			let timeStop = timeStart();
			const response = await page.goto(url);
			timeStop(`[${siteScraper!.serviceName}] page.goto "${url}"`);

			if (!response) {
				throw Error('Could not get response the page.');
			}
			const responseStatus = response ? response.status() : null;
			if (responseStatus !== 200) {
				throw Error(`Wrong response status ( ${responseStatus} ) .`);
			}
		} catch (err) {
			await page.close({ runBeforeUnload: true });
			throw new Error(
				`Unable to correctly load page:\n"${url}"\ndue to following error: \n ${err.message}`
			);
		}
		return page;
	}

	private async getPageContent(page: Page): Promise<cheerio.Root> {
		const content = await page.content();
		const $page = cheerio.load(content);
		return $page;
	}

	private validateOffers(offers: IOffer[], siteName: SiteName): IOffer[] {
		if (config.isDev) {
			const withMissingData = offers
				.map((x) => {
					if (
						x.id === '' ||
						x.title === '' ||
						x.price === '' ||
						x.url === '' ||
						x.dt === '' ||
						x.imgUrl === ''
					) {
						return x.id
							? x.id
							: x.url
							? x.url
							: x.title
							? x.title
							: JSON.stringify(x._debugInfo, null, 2);
					}
					return null;
				})
				.filter((x) => x != null);

			if (withMissingData.length > 0) {
				l.warn(
					`[${siteName}] Some of the ads have missing data`
					// withMissingData
				);
			}
		}
		return offers;
	}
}
