import path from "node:path";

import "dotenv/config";

import { Client, collectPaginatedAPI, isFullPage } from "@notionhq/client";

import {
    CheckboxPropertyItemObjectResponse,
    DatePropertyItemObjectResponse,
    GetPageResponse,
    LastEditedTimePropertyItemObjectResponse,
    MultiSelectPropertyItemObjectResponse,
    PropertyItemObjectResponse,
    QueryDataSourceParameters,
    TitlePropertyItemObjectResponse,
} from "@notionhq/client";
import {
    getChildBlocksWithChildrenRecursively,
    richTextAsPlainText,
} from "./notionHelper";
import { writePage, WritePageOpts } from "./writer";
// import log from "loglevel";
import { getColoredLogger } from "./coloredLogger";
import yargs from "yargs/yargs";

const log = getColoredLogger();

const argv = yargs(process.argv.slice(2))
    .options({
        verbosity: {
            type: "number",
            count: true,
            alias: "v",
        },
        quiet: {
            type: "boolean",
            alias: "q",
            default: false,
        },
    })
    .parseSync();

const notion = new Client({ auth: process.env.NOTION_KEY });

const databaseId = process.env.NOTION_DB_ID;
const dataSourceId = process.env.NOTION_DATA_SOURCE_ID;

if (!databaseId) {
    throw new Error("No Database ID");
}
if (!dataSourceId) {
    throw new Error("No Data Source ID");
}

const finalFilter: QueryDataSourceParameters = {
    data_source_id: dataSourceId,
    sorts: [
        {
            property: "事件日期",
            direction: "ascending",
        },
    ],
    filter: {
        // or: [lastMonthIndoorInclusiveFilter.filter, makeupFilter.filter],
        property: "状态",
        // @ts-ignore
        status: {
            equals: "未提交-下载",
            // equals: "需要信息",
        },
    },
};

(async () => {
    // console.log(argv.verbosity);

    // @ts-ignore
    log.setLevel(log.getLevel() - argv.verbosity);

    if (argv.quiet) {
        log.setLevel(log.levels.SILENT);
    }

    // console.log(log.getLevel());

    // log.trace("trace!");
    // log.debug("debug!");
    // log.info("info!");
    // log.warn("warn!");
    // log.error("error!");

    // console.log("Hi!");

    let sources = await collectPaginatedAPI(
        // iteratePaginatedAPI(
        notion.dataSources.query,
        // lastMonthIndoorInclusiveFilter
        finalFilter
        // )
        // iteratePaginatedAPI(notion.databases.query, lastMonthFilter)
    );

    let pages = sources.filter((source) => source.object === "page") as GetPageResponse[];

    // pages = pages.slice(15);

    console.log(`Total pages: ${pages.length}`);

    const TODAY = new Date();
    const year = TODAY.getFullYear();
    const month = (TODAY.getMonth() + 1).toString().padStart(2, "0");
    const date = (TODAY.getDate() + 1).toString().padStart(2, "0");
    const DEFAULT_DIR = `${year}${month}${date}-docx-result`;
    const OUTDOOR_DIR = "outdoor";
    const INDOOR_DIR = "indoor";
    const MAKEUP_DIR = "make-up";
    const NEWS = "播报申请";

    async function getPageProp(
        page: GetPageResponse,
        prop: string
    ): Promise<PropertyItemObjectResponse | PropertyItemObjectResponse[]> {
        if (isFullPage(page)) {
            const res = await notion.pages.properties.retrieve({
                page_id: page.id,
                property_id: page.properties[prop].id,
            });
            if (res.object === "list") {
                const list = await collectPaginatedAPI(
                    // @ts-ignore
                    notion.pages.properties.retrieve,
                    {
                        page_id: page.id,
                        property_id: page.properties[prop].id,
                    }
                );
                return list;
            } else {
                return res;
            }
        } else {
            // debug(`Page ${page.id} is not a full page}`);
            throw new Error(`Page ${page.id} is not a full page}`);
        }
    }

    for await (const page of pages) {
        // const title = page.properties["标题"].title;

        const date = (
            (await getPageProp(
                page,
                "事件日期"
            )) as DatePropertyItemObjectResponse
        ).date!;
        const titleRes = await getPageProp(page, "标题");
        const title = richTextAsPlainText(
            (titleRes as TitlePropertyItemObjectResponse[]).map(
                (title) => title.title
            )
        );
        const authors: string[] = (
            (await getPageProp(
                page,
                "记录者"
            )) as MultiSelectPropertyItemObjectResponse
        ).multi_select.map((option) => option.name);
        const category: string[] = (
            (await getPageProp(
                page,
                "负责"
            )) as MultiSelectPropertyItemObjectResponse
        ).multi_select.map((option) => option.name);
        const is_makeup: boolean = (
            (await getPageProp(
                page,
                "修改?"
            )) as CheckboxPropertyItemObjectResponse
        ).checkbox;

        const is_news: boolean = (
            (await getPageProp(
                page,
                "播报?"
            )) as CheckboxPropertyItemObjectResponse
        ).checkbox;

        // const lastEditedTime = new Date(
        //     (
        //         (await getPageProp(
        //             page,
        //             "最后修改时间"
        //         )) as LastEditedTimePropertyItemObjectResponse
        //     ).last_edited_time
        // );

        const dateParts = (
            (await getPageProp(
                page,
                "完成日期"
            )) as DatePropertyItemObjectResponse
        ).date!.start.split('-');
        const lastEditedDate = new Date(
            Number.parseInt(dateParts[0]),
            Number.parseInt(dateParts[1]) - 1,
            Number.parseInt(dateParts[2])
        );

        log.debug("Page Date:", date);
        log.debug("Page title:", title);
        let pageContent = await getChildBlocksWithChildrenRecursively(
            notion,
            page.id
        );

        log.debug(JSON.stringify(pageContent));

        // let content = (
        //     await asyncIterableToArray(
        //         iteratePaginatedAPI(notion.blocks.children.list, {
        //             block_id: page.id,
        //         })
        //     )
        // ).filter((b) => isFullBlock(b));

        const writePageOpts = {
            date,
            title,
            page: pageContent,
            authors,
            lastEditedTime: lastEditedDate,
        };

        // if (is_news) {
        //     await writePage({
        //         ...writePageOpts,
        //         parentDir: path.join(DEFAULT_DIR, NEWS),
        //     });
        // } else
        if (is_makeup) {
            await writePage({
                ...writePageOpts,
                parentDir: path.join(DEFAULT_DIR, MAKEUP_DIR),
            });
        } else if (category.includes("室外")) {
            await writePage({
                ...writePageOpts,
                parentDir: path.join(DEFAULT_DIR, OUTDOOR_DIR),
            });
        } else {
            await writePage({
                ...writePageOpts,
                parentDir: path.join(DEFAULT_DIR, INDOOR_DIR),
            });
        }
    }
})();
