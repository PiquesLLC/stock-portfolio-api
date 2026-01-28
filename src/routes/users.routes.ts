import { Router } from 'express';
import { getUsersHandler, getUserPortfolioHandler } from '../controllers/users.controller';

const router = Router();

router.get('/', getUsersHandler);
router.get('/:userId/portfolio', getUserPortfolioHandler);

export default router;
