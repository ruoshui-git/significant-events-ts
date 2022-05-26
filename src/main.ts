import "dotenv/config";

import { Client } from "@notionhq/client";

import { debug } from "debug";

import {
    asyncIterableToArray,
    iteratePaginatedAPI,
    getChildBlocksWithChildrenRecursively,
    richTextAsPlainText,
} from "./notionHelper";
import { writePage } from "./writer";
import { QueryDatabaseParameters } from "@notionhq/client/build/src/api-endpoints";

const DEBUG = debug("main.ts");

const notion = new Client({ auth: process.env.NOTION_KEY });

(async () => {
    const databaseId = process.env.NOTION_DB_ID;

    if (!databaseId) {
        throw new Error("No Database ID");
    }

    const lastMonthFilter: QueryDatabaseParameters = {
        database_id: databaseId,
        filter: {
            property: "上月?",
            checkbox: {
                equals: true,
            },
        },
        sorts: [
            {
                property: "事件日期",
                direction: "ascending",
            },
        ],
    };

    const lastMonthIndoorFilter: QueryDatabaseParameters = {
        ...lastMonthFilter,
        filter: {
            and: [
                {
                    property: "上月?",
                    checkbox: { equals: true },
                },
                {
                    property: "负责人",
                    multi_select: {
                        does_not_contain: "邹家琪",
                    },
                },
            ],
        },
    };

    let pages = await asyncIterableToArray(
        iteratePaginatedAPI(notion.databases.query, lastMonthFilter)
        // iteratePaginatedAPI(notion.databases.query, lastMonthIndoorFilter)
    );

    console.log(`Total pages: ${pages.length}`);

    for await (const page of pages) {
        // const title = page.properties["标题"].title;

        // @ts-ignore
        const date = page.properties["事件日期"].date;
        // @ts-ignore
        const title = richTextAsPlainText(page.properties["标题"].title);
        // @ts-ignore
        const authors = page.properties["记录者"].multi_select.map(
            // @ts-ignore
            (option) => option.name
        );

        DEBUG("Page Date: %s", date);
        DEBUG("Page title: %s, by %s", title);
        let pageContent = await getChildBlocksWithChildrenRecursively(
            notion,
            page.id
        );

        DEBUG("%s", JSON.stringify(pageContent));

        // let content = (
        //     await asyncIterableToArray(
        //         iteratePaginatedAPI(notion.blocks.children.list, {
        //             block_id: page.id,
        //         })
        //     )
        // ).filter((b) => isFullBlock(b));

        await writePage(date, title, pageContent, authors, "docx-indoor");
    }
})();
