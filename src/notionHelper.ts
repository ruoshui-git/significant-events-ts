import { Client } from "@notionhq/client";
import {
    GetBlockResponse,
    GetPageResponse,
} from "@notionhq/client/build/src/api-endpoints";
import debug from "debug";
import {
    Block,
    BlockType,
    ExtractedBlockType,
    RichText,
    RichTextMention,
} from "./types";

type NotionClient = Client;

const DEBUG = debug("helper.ts");

/**
 * @returns Plaintext string of rich text.
 * @category Rich Text
 */
export function richTextAsPlainText(
    richText: string | RichText[] | undefined
): string {
    if (!richText) {
        return "";
    }

    if (typeof richText === "string") {
        return richText;
    }

    // return "";
    return richText.map((token) => token.plain_text).join("");
}

/**
 * A page of results from the Notion API.
 * @category API
 */
export interface PaginatedList<T> {
    object: "list";
    results: T[];
    next_cursor: string | null;
    has_more: boolean;
}

/**
 * Common arguments for paginated APIs.
 * @category API
 */
export interface PaginatedArgs {
    start_cursor?: string;
    page_size?: number;
}

const DEBUG_ITERATE = DEBUG.extend("iterate");

/**
 * Iterate over all results in a paginated list API.
 *
 * ```typescript
 * for await (const block of iteratePaginatedAPI(notion.blocks.children.list, {
 *   block_id: parentBlockId,
 * })) {
 *   // Do something with block.
 * }
 * ```
 *
 * @param listFn API to call
 * @param firstPageArgs These arguments are used for each page, with an updated `start_cursor`.
 * @category API
 */
export async function* iteratePaginatedAPI<Args extends PaginatedArgs, Item>(
    listFn: (args: Args) => Promise<PaginatedList<Item>>,
    firstPageArgs: Args
): AsyncIterableIterator<Item> {
    let next_cursor: string | null | undefined = firstPageArgs.start_cursor;
    let has_more = true;
    let results: Item[] = [];
    let total = 0;
    let page = 0;

    while (has_more) {
        ({ results, next_cursor, has_more } = await listFn({
            ...firstPageArgs,
            start_cursor: next_cursor,
        }));
        page++;
        total += results.length;
        DEBUG_ITERATE(
            "%s: fetched page %s, %s (%s, %s total)",
            listFn.name,
            page,
            next_cursor ? "done" : "has more",
            results.length,
            total
        );
        yield* results;
    }
}

/**
 * Gather all an async iterable's items into an array.
 * ```typescript
 * const iterator = iteratePaginatedAPI(notion.blocks.children.list, { block_id: parentBlockId });
 * const blocks = await asyncIterableToArray(iterator);
 * const paragraphs = blocks.filter(block => isFullBlock(block, 'paragraph'))
 * ```
 * @category API
 */
export async function asyncIterableToArray<T>(
    iterable: AsyncIterable<T>
): Promise<Array<T>> {
    const array = [];
    for await (const item of iterable) {
        array.push(item);
    }
    return array;
}

////////////////////////////////////////////////////////////////////////////////
// Pages.
////////////////////////////////////////////////////////////////////////////////

/**
 * A full Notion API page.
 * @category Page
 */
export type Page = Extract<GetPageResponse, { parent: unknown }>;

/**
 * The Notion API may return a "partial" page object if your API token can't
 * access the page.
 *
 * This function confirms that all page data is available.
 * @category Page
 */
export function isFullPage(page: GetPageResponse): page is Page {
    return "parent" in page;
}

/**
 * An extension of the Notion API page type that ads a `children` attribute
 * forming a recursive tree of blocks.
 * @category Page
 */
export type PageWithChildren = Page & { children: BlockWithChildren[] };

/**
 * @category Page
 */
export function isPageWithChildren(
    page: GetPageResponse
): page is PageWithChildren {
    return isFullPage(page) && "children" in page;
}

/**
 * An extension of the Notion API block type that adds a `children` attribute
 * forming a recursive tree of blocks.
 * @category Block
 */
export type BlockWithChildren<Type extends BlockType = BlockType> =
    ExtractedBlockType<Type> & {
        children: BlockWithChildren[];
    };

/**
 * @category Block
 */
export function isBlockWithChildren(
    block: GetBlockResponse
): block is BlockWithChildren {
    return isFullBlock(block) && "children" in block;
}

/**
 * The Notion API may return a "partial" block object if your API token can't
 * access the block.
 *
 * This function confirms that all block data is available.
 * @category Block
 */
export function isFullBlock(block: GetBlockResponse): block is Block;
/**
 * The Notion API may return a "partial" block object if your API token can't
 * access the block.
 *
 * This function confirms that all block data is available, and the block has
 * type `blockType`.
 * @category Block
 */
export function isFullBlock<Type extends BlockType>(
    block: GetBlockResponse,
    blockType: Type
): block is ExtractedBlockType<Type>;
export function isFullBlock<Type extends BlockType>(
    block: GetBlockResponse,
    type?: Type
): block is ExtractedBlockType<Type> {
    return "type" in block && type ? block.type === type : true;
}

// type MentionType = RichTextMention['mention']['type']
export type DateResponse = Extract<
    RichTextMention["mention"],
    { type: "date" }
>["date"];

/**
 * Convert a Notion date's start into a Javascript Date object.
 * @category Date
 */
export function notionDateStartAsDate(date: DateResponse | Date): Date;
/**
 * Convert a Notion date's start into a Javascript Date object.
 * @category Date
 */
export function notionDateStartAsDate(
    date: DateResponse | Date | undefined
): Date | undefined;
export function notionDateStartAsDate(
    date: DateResponse | Date | undefined
): Date | undefined {
    if (!date) {
        return undefined;
    }

    if (date instanceof Date) {
        return date;
    }

    const start = date.start;
    return new Date(start);
}

////////////////////////////////////////////////////////////////////////////////
// Block children.
////////////////////////////////////////////////////////////////////////////////

const DEBUG_CHILDREN = DEBUG.extend('children');

/**
 * Fetch all supported children of a block.
 * @category Block
 */
 export async function getChildBlocks(
    notion: NotionClient,
    parentBlockId: string
  ): Promise<Block[]> {
    const blocks: Array<Block> = [];
  
    for await (const block of iteratePaginatedAPI(notion.blocks.children.list, {
      block_id: parentBlockId,
    })) {
      if (isFullBlock(block)) {
        blocks.push(block);
      }
    }
  
    return blocks;
  }
  

/**
 * Recursively fetch all children of `parentBlockId` as `BlockWithChildren`.
 * This function can be used to fetch an entire page's contents in one call.
 * @category Block
 */
export async function getChildBlocksWithChildrenRecursively(
    notion: NotionClient,
    parentId: string
): Promise<BlockWithChildren[]> {
    const blocks = (await getChildBlocks(
        notion,
        parentId
    )) as BlockWithChildren[];
    DEBUG_CHILDREN("parent %s: fetched %s children", parentId, blocks.length);

    if (blocks.length === 0) {
        return [];
    }

    const result = await Promise.all(
        blocks.map(async (block) => {
            if (block.has_children) {
                block.children = await getChildBlocksWithChildrenRecursively(
                    notion,
                    block.id
                );
            } else {
                block.children = [];
            }
            return block;
        })
    );
    DEBUG_CHILDREN("parent %s: finished descendants", parentId);

    return result;
}


