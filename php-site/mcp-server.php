<?php
declare(strict_types=1);

// Stateless Streamable HTTP MCP server (JSON-RPC 2.0) over POST /mcp.

const MCP_SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MCP_MAX_REQUEST_BYTES = 1048576; // 1 MiB
const MCP_MAX_BATCH_SIZE = 20;
const MCP_MAX_TEXT_OUTPUT_CHARS = 60000;

function mcp_server_instructions(): string {
    return "Read-only access to public SiYuan shared notes (notebooks and documents). Recommended workflow:\n"
        . "1) If the user mentions a course, topic, or semester without giving a URL, call `list_shares` first — it returns all notebooks AND each notebook's top-level course/subject nodes in a single call.\n"
        . "2) Pick the matching notebook and subject `doc_id`, then call `get_share_tree(share, parent_doc_id=..., max_depth=1)` to drill down step by step (e.g., Subject -> Lecture/Tutorial/Homework -> individual notes). Prefer expanding folder nodes (`child_count > 0`) rather than trying to read empty container nodes (`char_count == 0`).\n"
        . "3) Use `search_notes` to search across all public notebooks (or within one `share` / `parent_doc_id` subtree) when looking for specific theorems or concepts.\n"
        . "4) Call `read_document` (accepts either slug or full note URL) to read clean Markdown with LaTeX formulas preserved. For long documents, check `get_document_outline` first or continue reading via `next_offset`.";
}

function mcp_tool_definitions(): array {
    $readOnlyAnnotations = [
        'readOnlyHint' => true,
        'destructiveHint' => false,
        'idempotentHint' => true,
        'openWorldHint' => false,
    ];

    $nodeSchema = [
        'type' => 'object',
        'properties' => [
            'doc_id' => ['type' => 'string'],
            'title' => ['type' => 'string'],
            'child_count' => ['type' => 'integer'],
            'char_count' => ['type' => 'integer'],
            'url' => ['type' => ['string', 'null']],
        ],
        'required' => ['doc_id', 'title', 'child_count', 'char_count'],
    ];

    return [
        [
            'name' => 'list_shares',
            'description' => 'List all public shared notebooks and documents (including home flag) along with each notebook\'s top-level course/subject nodes so you can locate a subject in one call.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'cursor' => [
                        'type' => 'string',
                        'description' => 'Optional pagination cursor returned by a previous list_shares call.',
                    ],
                ],
                'additionalProperties' => false,
            ],
            'outputSchema' => [
                'type' => 'object',
                'properties' => [
                    'shares' => [
                        'type' => 'array',
                        'items' => [
                            'type' => 'object',
                            'properties' => [
                                'slug' => ['type' => 'string'],
                                'title' => ['type' => 'string'],
                                'type' => ['type' => 'string'],
                                'is_home' => ['type' => 'boolean'],
                                'doc_count' => ['type' => 'integer'],
                                'updated_at' => ['type' => 'string'],
                                'url' => ['type' => 'string'],
                                'top_level_docs' => ['type' => 'array', 'items' => $nodeSchema],
                                'has_more_roots' => ['type' => 'boolean'],
                            ],
                            'required' => ['slug', 'title', 'type', 'is_home', 'doc_count', 'url', 'top_level_docs'],
                        ],
                    ],
                    'total_returned' => ['type' => 'integer'],
                    'next_cursor' => ['type' => ['string', 'null']],
                ],
                'required' => ['shares', 'total_returned'],
            ],
            'annotations' => $readOnlyAnnotations,
        ],
        [
            'name' => 'get_share_tree',
            'description' => 'Browse the document tree of a public share or drill down into a specific course/category node via parent_doc_id. Defaults to max_depth=1 when parent_doc_id is specified, or max_depth=2 from the root.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'share' => [
                        'type' => 'string',
                        'description' => 'Share slug (e.g. "9898f37d") or full share URL.',
                    ],
                    'parent_doc_id' => [
                        'type' => 'string',
                        'description' => 'Optional doc_id of a folder/course/category node to expand its direct children or subtree.',
                    ],
                    'max_depth' => [
                        'type' => 'integer',
                        'minimum' => 1,
                        'maximum' => 6,
                        'description' => 'Maximum depth to expand (1-6). Defaults to 1 when parent_doc_id is given, otherwise 2.',
                    ],
                ],
                'required' => ['share'],
                'additionalProperties' => false,
            ],
            'outputSchema' => [
                'type' => 'object',
                'properties' => [
                    'share_slug' => ['type' => 'string'],
                    'share_title' => ['type' => 'string'],
                    'share_url' => ['type' => 'string'],
                    'doc_count' => ['type' => 'integer'],
                    'parent' => ['type' => ['object', 'null']],
                    'max_depth' => ['type' => 'integer'],
                    'returned_nodes' => ['type' => 'integer'],
                    'truncated' => ['type' => 'boolean'],
                    'hint' => ['type' => ['string', 'null']],
                    'nodes' => ['type' => 'array'],
                ],
                'required' => ['share_slug', 'share_title', 'doc_count', 'returned_nodes', 'truncated', 'nodes'],
            ],
            'annotations' => $readOnlyAnnotations,
        ],
        [
            'name' => 'read_document',
            'description' => 'Read the clean Markdown source of a public note (preserving LaTeX formulas, code blocks, tables, and Mermaid diagrams). Accepts a share slug or full note URL, and supports chunked reading via offset and max_chars.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'share' => [
                        'type' => 'string',
                        'description' => 'Share slug (e.g. "9898f37d") or full note URL (e.g. "https://note.etalib.space/s/9898f37d/<doc_id>").',
                    ],
                    'doc_id' => [
                        'type' => 'string',
                        'description' => 'Optional document ID (automatically extracted if already present in the share URL).',
                    ],
                    'offset' => [
                        'type' => 'integer',
                        'minimum' => 0,
                        'description' => 'UTF-8 character offset to start reading from (default 0). Matches offsets returned by get_document_outline and next_offset.',
                    ],
                    'max_chars' => [
                        'type' => 'integer',
                        'minimum' => 1000,
                        'maximum' => 50000,
                        'description' => 'Maximum UTF-8 characters to return in this chunk (default 20000, range 1000-50000).',
                    ],
                ],
                'required' => ['share'],
                'additionalProperties' => false,
            ],
            'outputSchema' => [
                'type' => 'object',
                'properties' => [
                    'content' => ['type' => 'string'],
                    'title' => ['type' => 'string'],
                    'hpath' => ['type' => 'string'],
                    'doc_id' => ['type' => 'string'],
                    'share_slug' => ['type' => 'string'],
                    'share_title' => ['type' => 'string'],
                    'updated_at' => ['type' => 'string'],
                    'url' => ['type' => 'string'],
                    'offset' => ['type' => 'integer'],
                    'returned_chars' => ['type' => 'integer'],
                    'next_offset' => ['type' => ['integer', 'null']],
                    'total_chars' => ['type' => 'integer'],
                    'note' => ['type' => ['string', 'null']],
                ],
                'required' => ['content', 'title', 'doc_id', 'share_slug', 'offset', 'returned_chars', 'total_chars'],
            ],
            'annotations' => $readOnlyAnnotations,
        ],
        [
            'name' => 'get_document_outline',
            'description' => 'Extract H1-H6 headings and their exact UTF-8 character offsets for a public note so you can jump directly to a section with read_document(offset=...).',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'share' => [
                        'type' => 'string',
                        'description' => 'Share slug or full note URL.',
                    ],
                    'doc_id' => [
                        'type' => 'string',
                        'description' => 'Optional document ID (extracted from share URL if present).',
                    ],
                ],
                'required' => ['share'],
                'additionalProperties' => false,
            ],
            'outputSchema' => [
                'type' => 'object',
                'properties' => [
                    'share_slug' => ['type' => 'string'],
                    'share_title' => ['type' => 'string'],
                    'doc_id' => ['type' => 'string'],
                    'title' => ['type' => 'string'],
                    'hpath' => ['type' => 'string'],
                    'url' => ['type' => 'string'],
                    'total_chars' => ['type' => 'integer'],
                    'headings' => [
                        'type' => 'array',
                        'items' => [
                            'type' => 'object',
                            'properties' => [
                                'level' => ['type' => 'integer'],
                                'title' => ['type' => 'string'],
                                'offset' => ['type' => 'integer'],
                            ],
                            'required' => ['level', 'title', 'offset'],
                        ],
                    ],
                ],
                'required' => ['share_slug', 'doc_id', 'title', 'total_chars', 'headings'],
            ],
            'annotations' => $readOnlyAnnotations,
        ],
        [
            'name' => 'search_notes',
            'description' => 'Search public notes by space-separated keywords across all public notebooks, within one share, or inside a specific course/folder subtree (parent_doc_id). Results are ranked by title match > path match > body match.',
            'inputSchema' => [
                'type' => 'object',
                'properties' => [
                    'query' => [
                        'type' => 'string',
                        'minLength' => 1,
                        'maxLength' => 200,
                        'description' => 'Search query keywords (all terms must match).',
                    ],
                    'share' => [
                        'type' => 'string',
                        'description' => 'Optional share slug or URL to restrict the search.',
                    ],
                    'parent_doc_id' => [
                        'type' => 'string',
                        'description' => 'Optional course/folder doc_id to restrict search to that subtree (requires share).',
                    ],
                    'limit' => [
                        'type' => 'integer',
                        'minimum' => 1,
                        'maximum' => 50,
                        'description' => 'Maximum number of results to return (default 20, range 1-50).',
                    ],
                ],
                'required' => ['query'],
                'additionalProperties' => false,
            ],
            'outputSchema' => [
                'type' => 'object',
                'properties' => [
                    'query' => ['type' => 'string'],
                    'total_returned' => ['type' => 'integer'],
                    'results' => [
                        'type' => 'array',
                        'items' => [
                            'type' => 'object',
                            'properties' => [
                                'share_slug' => ['type' => 'string'],
                                'share_title' => ['type' => 'string'],
                                'doc_id' => ['type' => 'string'],
                                'title' => ['type' => 'string'],
                                'hpath' => ['type' => 'string'],
                                'snippet' => ['type' => 'string'],
                                'url' => ['type' => 'string'],
                            ],
                            'required' => ['share_slug', 'doc_id', 'title', 'snippet', 'url'],
                        ],
                    ],
                ],
                'required' => ['query', 'total_returned', 'results'],
            ],
            'annotations' => $readOnlyAnnotations,
        ],
    ];
}

function mcp_origin_is_allowed(): bool {
    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($origin === '') {
        return true;
    }
    $originParts = parse_url($origin);
    $baseParts = parse_url(base_url());
    if (!is_array($originParts) || !is_array($baseParts)) {
        return false;
    }
    $oScheme = strtolower((string)($originParts['scheme'] ?? ''));
    $bScheme = strtolower((string)($baseParts['scheme'] ?? ''));
    $oHost = strtolower((string)($originParts['host'] ?? ''));
    $bHost = strtolower((string)($baseParts['host'] ?? ''));
    if ($oScheme === '' || $oHost === '' || $oScheme !== $bScheme || $oHost !== $bHost) {
        return false;
    }
    $oPort = (int)($originParts['port'] ?? ($oScheme === 'https' ? 443 : 80));
    $bPort = (int)($baseParts['port'] ?? ($bScheme === 'https' ? 443 : 80));
    return $oPort === $bPort;
}

function mcp_format_tool_text(string $toolName, array $data): string {
    $text = '';
    if ($toolName === 'list_shares') {
        $lines = [];
        foreach ($data['shares'] as $s) {
            $homeTag = !empty($s['is_home']) ? ' [HOME]' : '';
            $lines[] = "- **{$s['title']}**{$homeTag} (slug: `{$s['slug']}`, {$s['type']}, {$s['doc_count']} docs) — {$s['url']}";
            if (!empty($s['top_level_docs'])) {
                foreach ($s['top_level_docs'] as $root) {
                    $lines[] = "  - {$root['title']} (`doc_id`: `{$root['doc_id']}`, children: {$root['child_count']}, chars: {$root['char_count']})";
                }
                if (!empty($s['has_more_roots'])) {
                    $lines[] = '  - *(more top-level nodes available via get_share_tree)*';
                }
            }
        }
        $text = empty($lines) ? 'No public shares found.' : implode("\n", $lines);
    } elseif ($toolName === 'get_share_tree') {
        $lines = ["# {$data['share_title']} (`{$data['share_slug']}`, {$data['doc_count']} docs)"];
        if (is_array($data['parent'] ?? null)) {
            $lines[] = "Parent: {$data['parent']['title']} (`{$data['parent']['doc_id']}`)";
        }
        $renderNodes = static function (array $nodes, int $indent) use (&$renderNodes, &$lines): void {
            $pad = str_repeat('  ', $indent);
            foreach ($nodes as $n) {
                $lines[] = "{$pad}- {$n['title']} (`doc_id`: `{$n['doc_id']}`, children: {$n['child_count']}, chars: {$n['char_count']})";
                if (!empty($n['children'])) {
                    $renderNodes($n['children'], $indent + 1);
                }
            }
        };
        $renderNodes($data['nodes'], 0);
        if (!empty($data['hint'])) {
            $lines[] = '';
            $lines[] = $data['hint'];
        }
        $text = implode("\n", $lines);
    } elseif ($toolName === 'read_document') {
        $header = "# {$data['title']}\n"
            . "Share: {$data['share_title']} (`{$data['share_slug']}`) | Doc ID: `{$data['doc_id']}` | URL: {$data['url']}\n"
            . "Range: {$data['offset']}..+" . $data['returned_chars'] . " / {$data['total_chars']} chars";
        if ($data['next_offset'] !== null) {
            $header .= " (next_offset: {$data['next_offset']})";
        }
        if (!empty($data['note'])) {
            $header .= "\nNote: {$data['note']}";
        }
        $text = $header . "\n\n" . (string)$data['content'];
    } elseif ($toolName === 'get_document_outline') {
        $lines = ["# Outline: {$data['title']} (`{$data['doc_id']}`, {$data['total_chars']} chars)"];
        foreach ($data['headings'] as $h) {
            $pad = str_repeat('  ', max(0, (int)$h['level'] - 1));
            $lines[] = "{$pad}- H{$h['level']} {$h['title']} (offset: {$h['offset']})";
        }
        if (empty($data['headings'])) {
            $lines[] = '(No ATX headings found)';
        }
        $text = implode("\n", $lines);
    } elseif ($toolName === 'search_notes') {
        $lines = ["Search results for \"{$data['query']}\" ({$data['total_returned']} matches):"];
        foreach ($data['results'] as $r) {
            $hpath = $r['hpath'] !== '' ? " [{$r['hpath']}]" : '';
            $lines[] = "- **{$r['title']}**{$hpath} (share: `{$r['share_slug']}`, `doc_id`: `{$r['doc_id']}`) — {$r['url']}\n  {$r['snippet']}";
        }
        if (empty($data['results'])) {
            $lines[] = 'No matching public notes found.';
        }
        $text = implode("\n", $lines);
    } else {
        $text = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '';
    }

    if (mb_strlen($text, 'UTF-8') > MCP_MAX_TEXT_OUTPUT_CHARS) {
        $text = mb_substr($text, 0, MCP_MAX_TEXT_OUTPUT_CHARS - 32, 'UTF-8') . "\n\n[Output truncated]";
    }
    return $text;
}

function mcp_rpc_error($id, int $code, string $message, $data = null): array {
    $err = ['code' => $code, 'message' => $message];
    if ($data !== null) {
        $err['data'] = $data;
    }
    return ['jsonrpc' => '2.0', 'id' => $id, 'error' => $err];
}

function mcp_rpc_result($id, array|object $result): array {
    return ['jsonrpc' => '2.0', 'id' => $id, 'result' => $result];
}

function mcp_execute_tool(int $userId, string $toolName, array $args): array {
    if ($toolName === 'list_shares') {
        $cursor = array_key_exists('cursor', $args) && $args['cursor'] !== null ? (string)$args['cursor'] : null;
        if (array_key_exists('cursor', $args) && $args['cursor'] !== null && !is_string($args['cursor'])) {
            throw new InvalidArgumentException('cursor must be a string.');
        }
        return mcp_list_shares($userId, $cursor);
    }

    if ($toolName === 'get_share_tree') {
        if (!isset($args['share']) || !is_string($args['share'])) {
            throw new InvalidArgumentException('share must be a non-empty string.');
        }
        $parentDocId = null;
        if (array_key_exists('parent_doc_id', $args) && $args['parent_doc_id'] !== null) {
            if (!is_string($args['parent_doc_id'])) {
                throw new InvalidArgumentException('parent_doc_id must be a string.');
            }
            $parentDocId = $args['parent_doc_id'];
        }
        $maxDepth = null;
        if (array_key_exists('max_depth', $args) && $args['max_depth'] !== null) {
            if (!is_int($args['max_depth'])) {
                throw new InvalidArgumentException('max_depth must be an integer.');
            }
            $maxDepth = $args['max_depth'];
        }
        return mcp_get_share_tree($userId, $args['share'], $parentDocId, $maxDepth);
    }

    if ($toolName === 'read_document') {
        if (!isset($args['share']) || !is_string($args['share'])) {
            throw new InvalidArgumentException('share must be a non-empty string.');
        }
        $docId = null;
        if (array_key_exists('doc_id', $args) && $args['doc_id'] !== null) {
            if (!is_string($args['doc_id'])) {
                throw new InvalidArgumentException('doc_id must be a string.');
            }
            $docId = $args['doc_id'];
        }
        $offset = 0;
        if (array_key_exists('offset', $args) && $args['offset'] !== null) {
            if (!is_int($args['offset']) || $args['offset'] < 0) {
                throw new InvalidArgumentException('offset must be a non-negative integer.');
            }
            $offset = $args['offset'];
        }
        $maxChars = 20000;
        if (array_key_exists('max_chars', $args) && $args['max_chars'] !== null) {
            if (!is_int($args['max_chars'])) {
                throw new InvalidArgumentException('max_chars must be an integer.');
            }
            $maxChars = $args['max_chars'];
        }
        return mcp_read_document($userId, $args['share'], $docId, $offset, $maxChars);
    }

    if ($toolName === 'get_document_outline') {
        if (!isset($args['share']) || !is_string($args['share'])) {
            throw new InvalidArgumentException('share must be a non-empty string.');
        }
        $docId = null;
        if (array_key_exists('doc_id', $args) && $args['doc_id'] !== null) {
            if (!is_string($args['doc_id'])) {
                throw new InvalidArgumentException('doc_id must be a string.');
            }
            $docId = $args['doc_id'];
        }
        return mcp_get_document_outline($userId, $args['share'], $docId);
    }

    if ($toolName === 'search_notes') {
        if (!isset($args['query']) || !is_string($args['query'])) {
            throw new InvalidArgumentException('query must be a non-empty string.');
        }
        $share = null;
        if (array_key_exists('share', $args) && $args['share'] !== null) {
            if (!is_string($args['share'])) {
                throw new InvalidArgumentException('share must be a string.');
            }
            $share = $args['share'];
        }
        $parentDocId = null;
        if (array_key_exists('parent_doc_id', $args) && $args['parent_doc_id'] !== null) {
            if (!is_string($args['parent_doc_id'])) {
                throw new InvalidArgumentException('parent_doc_id must be a string.');
            }
            $parentDocId = $args['parent_doc_id'];
        }
        $limit = 20;
        if (array_key_exists('limit', $args) && $args['limit'] !== null) {
            if (!is_int($args['limit'])) {
                throw new InvalidArgumentException('limit must be an integer.');
            }
            $limit = $args['limit'];
        }
        return mcp_search_notes($userId, $args['query'], $share, $parentDocId, $limit);
    }

    throw new InvalidArgumentException('Unknown tool: ' . $toolName);
}

function mcp_dispatch_single_rpc(
    array $msg,
    int $userId,
    ?string &$rpcMethodOut,
    ?string &$protoOut,
    ?array &$metaOut = null,
    ?float $reqStart = null
): ?array {
    $rpcStart = $reqStart ?? microtime(true);
    $metaOut = ['is_error' => false, 'note' => null, 'chars' => 0, 'tokens' => 0];

    if (($msg['jsonrpc'] ?? null) !== '2.0' || !isset($msg['method']) || !is_string($msg['method'])) {
        $metaOut['is_error'] = true;
        $metaOut['note'] = 'rpc_error:-32600';
        return mcp_rpc_error($msg['id'] ?? null, -32600, 'Invalid JSON-RPC 2.0 request.');
    }

    $method = $msg['method'];
    $rpcMethodOut = $method;
    $hasId = array_key_exists('id', $msg);
    $id = $msg['id'] ?? null;
    $params = $msg['params'] ?? [];
    if (!is_array($params)) {
        if (!$hasId) {
            return null;
        }
        $metaOut['is_error'] = true;
        $metaOut['note'] = 'rpc_error:-32602';
        $dur = (int)round((microtime(true) - $rpcStart) * 1000);
        mcp_record_usage_stat($rpcMethodOut, $dur, true);
        return mcp_rpc_error($id, -32602, 'Invalid params: expected object.');
    }

    // Notifications (no id or notifications/* prefix) receive no JSON-RPC response body.
    if (!$hasId || str_starts_with($method, 'notifications/')) {
        $dur = (int)round((microtime(true) - $rpcStart) * 1000);
        mcp_record_usage_stat($rpcMethodOut, $dur, false);
        return null;
    }

    if ($method === 'initialize') {
        $requestedVersion = is_string($params['protocolVersion'] ?? null) ? $params['protocolVersion'] : '';
        $negotiated = in_array($requestedVersion, MCP_SUPPORTED_PROTOCOL_VERSIONS, true)
            ? $requestedVersion
            : MCP_SUPPORTED_PROTOCOL_VERSIONS[0];
        $protoOut = $negotiated;
        $dur = (int)round((microtime(true) - $rpcStart) * 1000);
        mcp_record_usage_stat('initialize', $dur, false);
        return mcp_rpc_result($id, [
            'protocolVersion' => $negotiated,
            'capabilities' => [
                'tools' => ['listChanged' => false],
            ],
            'serverInfo' => [
                'name' => 'Etalib Notes',
                'version' => site_version() !== '' ? site_version() : '1.0.0',
            ],
            'instructions' => mcp_server_instructions(),
        ]);
    }

    if ($method === 'ping') {
        $dur = (int)round((microtime(true) - $rpcStart) * 1000);
        mcp_record_usage_stat('ping', $dur, false);
        return mcp_rpc_result($id, new stdClass());
    }

    if ($method === 'tools/list') {
        $dur = (int)round((microtime(true) - $rpcStart) * 1000);
        mcp_record_usage_stat('tools/list', $dur, false);
        return mcp_rpc_result($id, ['tools' => mcp_tool_definitions()]);
    }

    if ($method === 'resources/list') {
        $dur = (int)round((microtime(true) - $rpcStart) * 1000);
        mcp_record_usage_stat('resources/list', $dur, false);
        return mcp_rpc_result($id, ['resources' => []]);
    }

    if ($method === 'prompts/list') {
        $dur = (int)round((microtime(true) - $rpcStart) * 1000);
        mcp_record_usage_stat('prompts/list', $dur, false);
        return mcp_rpc_result($id, ['prompts' => []]);
    }

    if ($method === 'tools/call') {
        $toolName = $params['name'] ?? null;
        $arguments = $params['arguments'] ?? [];
        if (!is_string($toolName) || $toolName === '' || !is_array($arguments)) {
            $metaOut['is_error'] = true;
            $metaOut['note'] = 'rpc_error:-32602';
            $dur = (int)round((microtime(true) - $rpcStart) * 1000);
            mcp_record_usage_stat('tools/call', $dur, true);
            return mcp_rpc_error($id, -32602, 'Invalid tools/call parameters.');
        }
        $rpcMethodOut = 'tools/call:' . $toolName;
        $knownNames = array_column(mcp_tool_definitions(), 'name');
        if (!in_array($toolName, $knownNames, true)) {
            $metaOut['is_error'] = true;
            $metaOut['note'] = 'rpc_error:-32602';
            $dur = (int)round((microtime(true) - $rpcStart) * 1000);
            mcp_record_usage_stat('tools/call:unknown', $dur, true);
            return mcp_rpc_error($id, -32602, 'Unknown tool: ' . $toolName);
        }
        $argJson = !empty($arguments) ? (json_encode($arguments, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '') : '';
        $argEst = mcp_estimate_tokens($argJson);
        try {
            $structured = mcp_execute_tool($userId, $toolName, $arguments);
            $text = mcp_format_tool_text($toolName, $structured);
            $outEst = mcp_estimate_tokens($text);
            $totalChars = $argEst['chars'] + $outEst['chars'];
            $totalTokens = $argEst['tokens'] + $outEst['tokens'];
            $dur = (int)round((microtime(true) - $rpcStart) * 1000);
            $metaOut['chars'] = $totalChars;
            $metaOut['tokens'] = $totalTokens;
            mcp_record_usage_stat($rpcMethodOut, $dur, false, $totalChars, $totalTokens);
            return mcp_rpc_result($id, [
                'content' => [
                    ['type' => 'text', 'text' => $text],
                ],
                'structuredContent' => $structured,
                'isError' => false,
            ]);
        } catch (InvalidArgumentException $e) {
            $dur = (int)round((microtime(true) - $rpcStart) * 1000);
            $metaOut['is_error'] = true;
            $metaOut['note'] = 'rpc_error:-32602';
            $metaOut['chars'] = $argEst['chars'];
            $metaOut['tokens'] = $argEst['tokens'];
            mcp_record_usage_stat($rpcMethodOut, $dur, true, $argEst['chars'], $argEst['tokens']);
            return mcp_rpc_error($id, -32602, $e->getMessage());
        } catch (RuntimeException $e) {
            $errEst = mcp_estimate_tokens($e->getMessage());
            $totalChars = $argEst['chars'] + $errEst['chars'];
            $totalTokens = $argEst['tokens'] + $errEst['tokens'];
            $dur = (int)round((microtime(true) - $rpcStart) * 1000);
            $metaOut['is_error'] = true;
            $metaOut['note'] = 'tool_error';
            $metaOut['chars'] = $totalChars;
            $metaOut['tokens'] = $totalTokens;
            mcp_record_usage_stat($rpcMethodOut, $dur, true, $totalChars, $totalTokens);
            return mcp_rpc_result($id, [
                'content' => [
                    ['type' => 'text', 'text' => $e->getMessage()],
                ],
                'isError' => true,
            ]);
        }
    }

    $metaOut['is_error'] = true;
    $metaOut['note'] = 'rpc_error:-32601';
    return mcp_rpc_error($id, -32601, 'Method not found: ' . $method);
}

function handle_mcp_request(): void {
    $start = microtime(true);
    if (!mcp_is_enabled()) {
        mcp_json_response(404, ['error' => 'not_found']);
    }

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'POST') {
        mcp_debug_log($method, '/mcp', 405, (int)round((microtime(true) - $start) * 1000), null, null, 'sse_probe_unsupported');
        mcp_json_response(405, ['error' => 'method_not_allowed'], ['Allow: POST']);
    }

    if (!mcp_origin_is_allowed()) {
        mcp_debug_log('POST', '/mcp', 403, (int)round((microtime(true) - $start) * 1000), null, null, 'origin_rejected');
        mcp_json_response(403, ['error' => 'forbidden', 'error_description' => 'Origin not allowed.']);
    }

    // Authenticate Bearer token before reading/processing RPC payload.
    $auth = mcp_authenticate_bearer_request();
    $userId = (int)$auth['user']['id'];
    $tokenHash = (string)$auth['token']['token_hash'];

    // Read body with strict 1 MiB ceiling.
    $raw = file_get_contents('php://input', false, null, 0, MCP_MAX_REQUEST_BYTES + 1);
    if ($raw === false) {
        $raw = '';
    }
    if (strlen($raw) > MCP_MAX_REQUEST_BYTES) {
        mcp_debug_log('POST', '/mcp', 413, (int)round((microtime(true) - $start) * 1000), null, null, 'payload_too_large');
        mcp_json_response(413, ['error' => 'payload_too_large', 'error_description' => 'Request body exceeds 1 MB limit.']);
    }

    $decoded = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE || !is_array($decoded)) {
        mcp_debug_log('POST', '/mcp', 400, (int)round((microtime(true) - $start) * 1000), null, null, 'parse_error');
        mcp_json_response(400, mcp_rpc_error(null, -32700, 'Parse error: invalid JSON.'));
    }

    $isBatch = array_is_list($decoded);
    if ($isBatch) {
        if (empty($decoded) || count($decoded) > MCP_MAX_BATCH_SIZE) {
            mcp_debug_log('POST', '/mcp', 400, (int)round((microtime(true) - $start) * 1000), 'batch', null, 'invalid_batch_size');
            mcp_json_response(400, mcp_rpc_error(null, -32600, 'Invalid batch request (must contain 1 to ' . MCP_MAX_BATCH_SIZE . ' items).'));
        }
        $cost = count($decoded);
    } else {
        $cost = 1;
    }

    // Dual-dimension rate limiting: 120 req/min per token, 300 req/min per trusted client IP.
    $tokenLimit = mcp_rate_limit_check('mcp:tok:' . substr($tokenHash, 0, 32), 120, 60, $cost);
    if (!$tokenLimit['allowed']) {
        mcp_debug_log('POST', '/mcp', 429, (int)round((microtime(true) - $start) * 1000), null, null, 'token_rate_limited');
        mcp_json_response(429, ['error' => 'rate_limited', 'error_description' => 'Token rate limit exceeded.'], ['Retry-After: ' . $tokenLimit['retry_after']]);
    }
    $ipLimit = mcp_rate_limit_check('mcp:ip:' . trusted_client_ip_hash(), 300, 60, $cost);
    if (!$ipLimit['allowed']) {
        mcp_debug_log('POST', '/mcp', 429, (int)round((microtime(true) - $start) * 1000), null, null, 'ip_rate_limited');
        mcp_json_response(429, ['error' => 'rate_limited', 'error_description' => 'IP rate limit exceeded.'], ['Retry-After: ' . $ipLimit['retry_after']]);
    }

    $headerProto = trim((string)($_SERVER['HTTP_MCP_PROTOCOL_VERSION'] ?? ''));
    $protoOut = $headerProto !== '' ? $headerProto : null;
    $rpcMethodOut = null;

    if ($isBatch) {
        $responses = [];
        $batchTokens = 0;
        $batchChars = 0;
        $batchNote = null;
        foreach ($decoded as $item) {
            if (!is_array($item)) {
                $responses[] = mcp_rpc_error(null, -32600, 'Invalid JSON-RPC request object.');
                if ($batchNote === null) {
                    $batchNote = 'rpc_error:-32600';
                }
                continue;
            }
            $itemRpc = null;
            $itemProto = null;
            $itemMeta = null;
            $res = mcp_dispatch_single_rpc($item, $userId, $itemRpc, $itemProto, $itemMeta);
            if ($rpcMethodOut === null && $itemRpc !== null) {
                $rpcMethodOut = 'batch:' . $itemRpc;
            }
            if ($itemProto !== null) {
                $protoOut = $itemProto;
            }
            if (is_array($itemMeta)) {
                $batchTokens += (int)($itemMeta['tokens'] ?? 0);
                $batchChars += (int)($itemMeta['chars'] ?? 0);
                if ($batchNote === null && !empty($itemMeta['note'])) {
                    $batchNote = (string)$itemMeta['note'];
                }
            }
            if ($res !== null) {
                $responses[] = $res;
            }
        }
        $dur = (int)round((microtime(true) - $start) * 1000);
        if (empty($responses)) {
            mcp_debug_log('POST', '/mcp', 202, $dur, $rpcMethodOut, $protoOut, $batchNote, $batchTokens, $batchChars);
            http_response_code(202);
            header('Cache-Control: no-store');
            exit;
        }
        mcp_debug_log('POST', '/mcp', 200, $dur, $rpcMethodOut, $protoOut, $batchNote, $batchTokens, $batchChars);
        http_response_code(200);
        header('Content-Type: application/json; charset=utf-8');
        header('Cache-Control: no-store');
        echo json_encode($responses, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    $rpcMeta = null;
    $response = mcp_dispatch_single_rpc($decoded, $userId, $rpcMethodOut, $protoOut, $rpcMeta, $start);
    $dur = (int)round((microtime(true) - $start) * 1000);
    $rpcNote = is_array($rpcMeta) && !empty($rpcMeta['note']) ? (string)$rpcMeta['note'] : null;
    $rpcTokens = is_array($rpcMeta) ? (int)($rpcMeta['tokens'] ?? 0) : 0;
    $rpcChars = is_array($rpcMeta) ? (int)($rpcMeta['chars'] ?? 0) : 0;
    if ($response === null) {
        mcp_debug_log('POST', '/mcp', 202, $dur, $rpcMethodOut, $protoOut, $rpcNote, $rpcTokens, $rpcChars);
        http_response_code(202);
        header('Cache-Control: no-store');
        exit;
    }

    mcp_debug_log('POST', '/mcp', 200, $dur, $rpcMethodOut, $protoOut, $rpcNote, $rpcTokens, $rpcChars);
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($response, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}
