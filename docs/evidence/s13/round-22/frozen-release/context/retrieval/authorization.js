export function authorizeRetrieval(input) {
    const fragments = new Map(input.fragments.map((fragment) => [fragment.id, fragment]));
    const allowed = new Set(input.allowedFragmentIds);
    for (const id of allowed)
        if (!fragments.has(id))
            throw new Error(`Cannot authorize unknown context fragment '${id}'.`);
    return { ...input, allowedFragmentIds: [...allowed].sort(), fragments };
}
//# sourceMappingURL=authorization.js.map