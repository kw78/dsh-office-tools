/**
 * Shared schema fragments, cell types, and the ASCII-safe XML encoders for
 * the Office tool suite. Keeping the schemas in one place keeps the eight
 * tool contracts consistent; the encoders guarantee that generated XML stays
 * pure ASCII (non-ASCII text becomes decimal character references), which is
 * the invariant the ASCII-safe zip writer builds on.
 */
/** One cell value accepted by the Excel tools. */
export declare const CELL_VALUE_SCHEMA: {
    readonly oneOf: readonly [{
        readonly type: "string";
    }, {
        readonly type: "number";
    }, {
        readonly type: "boolean";
    }, {
        readonly type: "null";
    }];
};
/** One spreadsheet row. */
export declare const ROW_SCHEMA: {
    readonly type: "array";
    readonly items: {
        readonly oneOf: readonly [{
            readonly type: "string";
        }, {
            readonly type: "number";
        }, {
            readonly type: "boolean";
        }, {
            readonly type: "null";
        }];
    };
};
/** Common success echo for a created/replaced file. */
export declare const FILE_RESULT_SCHEMA: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly properties: {
        readonly path: {
            readonly type: "string";
            readonly required: true;
        };
        readonly sizeBytes: {
            readonly type: "integer";
            readonly required: true;
        };
    };
};
export type CellValue = string | number | boolean | null;
export type CellRow = CellValue[];
/** Escape text for XML element content, keeping the output pure ASCII. */
export declare function encodeXmlText(value: string): string;
/** Escape text for a double-quoted XML attribute value, keeping it pure ASCII. */
export declare function encodeXmlAttribute(value: string): string;
/**
 * Decode the XML entities that can legally appear in OOXML text content: the
 * five predefined names plus decimal/hex character references.
 */
export declare function decodeXmlEntities(value: string): string;
