/**
 * An iterator with an additional `peek` method.
 */
export type PeekingIterator<T> = Iterator<T> & {
    readonly peek: () => {
        value: T;
        done?: boolean;
    };
};

/**
 * Wrap an iterator into a peeking iterator. Note that calling `peek` takes the item from the specified iterator, but does not take it from the peeking iterator.
 */
export function fromIterator<T>(it: Iterator<T>): PeekingIterator<T> {
    let current = it.next();
    return {
        peek: () => current,
        next: () => {
            const temp = current;
            current = it.next();
            return temp;
        },
    };
}

/**
 * Get a peeking iterator for an iterable.
 */
export function fromIterable<T>(it: Iterable<T>): PeekingIterator<T> {
    return fromIterator(it[Symbol.iterator]());
}
