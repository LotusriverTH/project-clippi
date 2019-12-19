import * as React from "react";

import { HashRouter as Router } from "react-router-dom";

import { Main } from "./Main";

export const App: React.FC = () => {
    return (
        <Router>
            <Main />
        </Router>
    );
};
