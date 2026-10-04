// gm-class-look: draw GM accounts as their class instead of the GM suit.
//
// The client draws any account on its GM list (adminList: the built-in
// `ragnarok` account) in the GM sprite, whatever its job, and styles its name
// and chat as a GM's. That is all looks: GM commands come from the server's
// group, which this does not touch. api.players.gmLook turns the sprite off,
// and the name and chat styles too unless the settings keep them.

export function parts(parameters = {}) {
    return {
        sprite: false,
        name: parameters?.keep_gm_name !== false,
        chat: parameters?.keep_gm_chat !== false,
    };
}

export default function init(parameters, api) {
    // A client without the GM-look switches: nothing to do, and nothing to
    // break.
    if (api?.version !== 1 || !api.players?.gmLookSupported?.()) return;
    api.players.gmLook(parts(parameters));
}
