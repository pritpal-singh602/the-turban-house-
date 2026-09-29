require("dotenv").config();

const express = require("express");
const cors = require("cors");
const mysql = require("mysql2/promise");
const path = require("path");
const crypto = require("crypto");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Serve the complete website from the same Node/Express service.
// This makes the project deployable on Railway/Render without a separate frontend host.
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

let db;

const SERVICE_BLOCK_MESSAGE = "Annual service has expired or is unpaid. Ordering and checkout are temporarily disabled. Please renew the service plan.";

function addOneYear(date){
    const d = new Date(date);
    d.setFullYear(d.getFullYear() + 1);
    return d;
}

function safeDate(value, fallback){
    const d = value ? new Date(value) : new Date(fallback);
    return Number.isNaN(d.getTime()) ? new Date(fallback) : d;
}

async function getServicePlan(){
    const [rows] = await db.query("SELECT * FROM service_plan WHERE id=1 LIMIT 1");
    if(rows.length) return rows[0];
    const started = safeDate(process.env.SERVICE_START_DATE, new Date());
    const expires = addOneYear(started);
    const charge = Number(process.env.SERVICE_ANNUAL_CHARGE || 0);
    const status = String(process.env.SERVICE_PAYMENT_STATUS || "paid").toLowerCase() === "paid" ? "paid" : "unpaid";
    await db.query(`INSERT INTO service_plan (id,plan_name,annual_charge,currency,started_at,expires_at,payment_status,auto_block_orders) VALUES (1,?,?,?,?,?,?,1)`, ["Annual Service Plan", charge, "INR", started, expires, status]);
    const [created] = await db.query("SELECT * FROM service_plan WHERE id=1 LIMIT 1");
    return created[0];
}

function isServiceActive(plan){
    if(!plan) return false;
    const expires = new Date(plan.expires_at);
    return expires.getTime() > Date.now();
}

async function requireActiveService(req,res,next){
    try{
        if(!db) return res.status(503).json({success:false,message:"Database is not connected"});
        const plan = await getServicePlan();
        if(plan.auto_block_orders && !isServiceActive(plan)){
            return res.status(402).json({success:false,code:"SERVICE_EXPIRED",message:SERVICE_BLOCK_MESSAGE,service:serializeService(plan)});
        }
        next();
    }catch(e){
        console.error("Service check failed:",e.message);
        return res.status(500).json({success:false,message:"Unable to verify service status"});
    }
}

function serializeService(plan){
    if(!plan) return null;
    return {
        planName: plan.plan_name,
        annualCharge: Number(plan.annual_charge || 0),
        currency: plan.currency || "INR",
        startedAt: plan.started_at,
        expiresAt: plan.expires_at,
        paymentStatus: plan.payment_status,
        active: isServiceActive(plan),
        autoBlockOrders: !!plan.auto_block_orders
    };
}

function passwordMatches(input){
    const expected = String(process.env.ADMIN_PASSWORD || "");
    const actual = String(input || "");
    if(!expected || !actual || expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}


/* =====================================================
   DATABASE CONNECTION
===================================================== */

async function connectDatabase() {

    try {

        db = await mysql.createPool({
            host: process.env.DB_HOST,
            port: process.env.DB_PORT || 3306,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,

            // Aiven MySQL SSL
            ssl: {
                rejectUnauthorized: false
            },

            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });

        // Test database connection
        await db.query("SELECT 1");

        console.log("✅ Database connected successfully");

        await createTables();

    } catch (error) {

        console.error("❌ Database connection failed:");
        console.error(error.message);

    }

}


/* =====================================================
   CREATE TABLES
===================================================== */

async function createTables() {

    try {

        /* ANNUAL SERVICE PLAN */

        await db.query(`
            CREATE TABLE IF NOT EXISTS service_plan (
                id TINYINT PRIMARY KEY,
                plan_name VARCHAR(100) NOT NULL DEFAULT 'Annual Service Plan',
                annual_charge DECIMAL(10,2) NOT NULL DEFAULT 0,
                currency VARCHAR(10) NOT NULL DEFAULT 'INR',
                started_at DATETIME NOT NULL,
                expires_at DATETIME NOT NULL,
                payment_status VARCHAR(20) NOT NULL DEFAULT 'paid',
                auto_block_orders TINYINT(1) NOT NULL DEFAULT 1,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);

        /* PRODUCTS */

        await db.query(`
            CREATE TABLE IF NOT EXISTS products (

                id INT AUTO_INCREMENT PRIMARY KEY,

                name VARCHAR(255) NOT NULL,

                category VARCHAR(100),

                sku VARCHAR(100),

                price DECIMAL(10,2) DEFAULT 0,

                sale_price DECIMAL(10,2) DEFAULT NULL,

                stock INT DEFAULT 0,

                description TEXT,

                size VARCHAR(100),

                colour VARCHAR(100),

                image LONGTEXT,

                status VARCHAR(30) DEFAULT 'active',

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP

            )
        `);


        // Backward-compatible columns for existing databases
        try { await db.query("ALTER TABLE products ADD COLUMN size VARCHAR(100) NULL"); } catch(e) {}
        try { await db.query("ALTER TABLE products ADD COLUMN colour VARCHAR(100) NULL"); } catch(e) {}

        /* CUSTOMERS */

        await db.query(`
            CREATE TABLE IF NOT EXISTS customers (

                id INT AUTO_INCREMENT PRIMARY KEY,

                name VARCHAR(255) NOT NULL,

                mobile VARCHAR(20),

                email VARCHAR(255),

                address TEXT,

                city VARCHAR(100),

                state VARCHAR(100),

                pincode VARCHAR(10),

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

            )
        `);


        /* ORDERS */

        await db.query(`
            CREATE TABLE IF NOT EXISTS orders (

                id VARCHAR(50) PRIMARY KEY,

                customer_id INT NULL,

                customer_name VARCHAR(255),

                mobile VARCHAR(20),

                email VARCHAR(255),

                address TEXT,

                city VARCHAR(100),

                state VARCHAR(100),

                pincode VARCHAR(10),

                notes TEXT,

                payment_method VARCHAR(100),

                payment_status VARCHAR(50) DEFAULT 'Pending',

                status VARCHAR(50) DEFAULT 'Pending',

                subtotal DECIMAL(10,2) DEFAULT 0,

                shipping DECIMAL(10,2) DEFAULT 0,

                total DECIMAL(10,2) DEFAULT 0,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                FOREIGN KEY (customer_id)
                REFERENCES customers(id)
                ON DELETE SET NULL

            )
        `);


        /* ORDER ITEMS */

        await db.query(`
            CREATE TABLE IF NOT EXISTS order_items (

                id INT AUTO_INCREMENT PRIMARY KEY,

                order_id VARCHAR(50) NOT NULL,

                product_id INT NULL,

                name VARCHAR(255),

                category VARCHAR(100),

                sku VARCHAR(100),

                price DECIMAL(10,2) DEFAULT 0,

                quantity INT DEFAULT 1,

                total DECIMAL(10,2) DEFAULT 0,

                image LONGTEXT,

                FOREIGN KEY (order_id)
                REFERENCES orders(id)
                ON DELETE CASCADE

            )
        `);


        /* COUPONS */

        await db.query(`
            CREATE TABLE IF NOT EXISTS coupons (

                id INT AUTO_INCREMENT PRIMARY KEY,

                code VARCHAR(100) UNIQUE NOT NULL,

                discount_type VARCHAR(30) DEFAULT 'percentage',

                discount_value DECIMAL(10,2) DEFAULT 0,

                min_order DECIMAL(10,2) DEFAULT 0,

                max_discount DECIMAL(10,2) DEFAULT NULL,

                status VARCHAR(30) DEFAULT 'active',

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

            )
        `);


        /* REVIEWS */

        await db.query(`
            CREATE TABLE IF NOT EXISTS reviews (

                id INT AUTO_INCREMENT PRIMARY KEY,

                product_id INT NOT NULL,

                customer_name VARCHAR(255),

                rating INT DEFAULT 5,

                review TEXT,

                status VARCHAR(30) DEFAULT 'active',

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP

            )
        `);


        await getServicePlan();
        console.log("✅ All database tables are ready");

    } catch (error) {

        console.error("❌ Table creation failed:");
        console.error(error.message);

    }

}


/* =====================================================
   HOME
===================================================== */

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "welcome.html"));
});


/* =====================================================
   HEALTH CHECK
===================================================== */

app.get("/api/health", async (req, res) => {

    try {

        if (!db) {

            return res.status(503).json({

                success: false,

                message: "Database is not connected"

            });

        }

        await db.query("SELECT 1");

        res.json({

            success: true,

            message:
                "Backend and database are working"

        });

    } catch (error) {

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});


/* =====================================================
   GET ALL PRODUCTS
===================================================== */

app.get("/api/products", async (req, res) => {

    try {

        if (!db) {
            return res.status(503).json({
                success: false,
                message: "Database is not connected"
            });
        }

        const [rows] = await db.query(`
            SELECT
                id,
                name,
                category,
                sku,
                price,
                sale_price AS salePrice,
                stock,
                description,
                size,
                colour,
                image,
                status,
                (status = 'active') AS active,
                created_at AS createdAt,
                updated_at AS updatedAt
            FROM products
            ORDER BY id DESC
        `);

        res.json({

            success: true,

            products: rows

        });

    } catch (error) {

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});


/* =====================================================
   GET SINGLE PRODUCT
===================================================== */

app.get("/api/products/:id", async (req, res) => {

    try {

        if (!db) {
            return res.status(503).json({
                success: false,
                message: "Database is not connected"
            });
        }

        const [rows] = await db.query(
            `
            SELECT
                id,
                name,
                category,
                sku,
                price,
                sale_price AS salePrice,
                stock,
                description,
                size,
                colour,
                image,
                status,
                (status = 'active') AS active
            FROM products
            WHERE id = ?
            `,
            [req.params.id]
        );


        if (!rows.length) {

            return res.status(404).json({

                success: false,

                message: "Product not found"

            });

        }


        res.json({

            success: true,

            product: rows[0]

        });

    } catch (error) {

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});


/* =====================================================
   ADD PRODUCT
===================================================== */

app.post("/api/products", async (req, res) => {

    try {

        const {

            name,
            category,
            sku,
            price,
            salePrice,
            stock,
            description,
            size,
            colour,
            image,
            status

        } = req.body;


        if (!name || !String(name).trim()) {

            return res.status(400).json({

                success: false,

                message: "Product name is required"

            });

        }


        const [result] = await db.query(
            `
            INSERT INTO products
            (
                name,
                category,
                sku,
                price,
                sale_price,
                stock,
                description,
                size,
                colour,
                image,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [

                name,

                category || "",

                sku || "",

                Number(price || 0),

                salePrice !== "" &&
                salePrice !== null &&
                salePrice !== undefined
                    ? Number(salePrice)
                    : null,

                Number(stock || 0),

                description || "",

                req.body.size || "",

                req.body.colour || "",

                image || "",

                status || "active"

            ]
        );


        res.status(201).json({

            success: true,

            message: "Product added successfully",

            productId: result.insertId

        });

    } catch (error) {

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});


/* =====================================================
   UPDATE PRODUCT
===================================================== */

app.put("/api/products/:id", async (req, res) => {

    try {

        const {

            name,
            category,
            sku,
            price,
            salePrice,
            stock,
            description,
            image,
            status

        } = req.body;


        const [result] = await db.query(
            `
            UPDATE products

            SET
                name = ?,
                category = ?,
                sku = ?,
                price = ?,
                sale_price = ?,
                stock = ?,
                description = ?,
                size = ?,
                colour = ?,
                image = ?,
                status = ?

            WHERE id = ?
            `,
            [

                name,

                category || "",

                sku || "",

                Number(price || 0),

                salePrice !== "" &&
                salePrice !== null &&
                salePrice !== undefined
                    ? Number(salePrice)
                    : null,

                Number(stock || 0),

                description || "",

                req.body.size || "",

                req.body.colour || "",

                image || "",

                status || "active",

                req.params.id

            ]
        );


        if (!result.affectedRows) {

            return res.status(404).json({

                success: false,

                message: "Product not found"

            });

        }


        res.json({

            success: true,

            message: "Product updated successfully"

        });

    } catch (error) {

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});


/* =====================================================
   DELETE PRODUCT
===================================================== */

app.delete("/api/products/:id", async (req, res) => {

    try {

        const [result] = await db.query(
            `
            DELETE FROM products
            WHERE id = ?
            `,
            [req.params.id]
        );


        if (!result.affectedRows) {

            return res.status(404).json({

                success: false,

                message: "Product not found"

            });

        }


        res.json({

            success: true,

            message: "Product deleted successfully"

        });

    } catch (error) {

        res.status(500).json({

            success: false,

            message: error.message

        });

    }

});



/* =====================================================
   ANNUAL SERVICE PLAN
===================================================== */

app.get("/api/service-status", async (req,res) => {
    try {
        if(!db) return res.status(503).json({success:false,message:"Database is not connected"});
        const plan = await getServicePlan();
        res.json({success:true,service:serializeService(plan)});
    } catch(error) {
        res.status(500).json({success:false,message:error.message});
    }
});

app.put("/api/service-plan", async (req,res) => {
    try {
        if(!db) return res.status(503).json({success:false,message:"Database is not connected"});
        if(!passwordMatches(req.body.adminPassword)) return res.status(401).json({success:false,message:"Invalid admin password"});
        const current = await getServicePlan();
        const annualCharge = Math.max(0, Number(req.body.annualCharge ?? current.annual_charge ?? 0));
        const started = safeDate(req.body.startedAt, current.started_at);
        let expires = req.body.expiresAt ? safeDate(req.body.expiresAt, current.expires_at) : new Date(current.expires_at);
        const paymentStatus = String(req.body.paymentStatus || current.payment_status || "unpaid").toLowerCase() === "paid" ? "paid" : "unpaid";
        const autoBlock = req.body.autoBlockOrders === false ? 0 : 1;
        await db.query(`UPDATE service_plan SET annual_charge=?,started_at=?,expires_at=?,payment_status=?,auto_block_orders=? WHERE id=1`, [annualCharge, started, expires, paymentStatus, autoBlock]);
        const updated = await getServicePlan();
        res.json({success:true,service:serializeService(updated)});
    } catch(error) {
        res.status(500).json({success:false,message:error.message});
    }
});

app.post("/api/service-plan/renew", async (req,res) => {
    try {
        if(!db) return res.status(503).json({success:false,message:"Database is not connected"});
        if(!passwordMatches(req.body.adminPassword)) return res.status(401).json({success:false,message:"Invalid admin password"});
        const current = await getServicePlan();
        const base = new Date(current.expires_at).getTime() > Date.now() ? new Date(current.expires_at) : new Date();
        const expires = addOneYear(base);
        await db.query(`UPDATE service_plan SET started_at=CASE WHEN ? THEN started_at ELSE ? END, expires_at=?, payment_status='paid', auto_block_orders=1 WHERE id=1`, [current.payment_status === "paid" && new Date(current.expires_at) > new Date(), new Date(), expires]);
        const updated = await getServicePlan();
        res.json({success:true,message:"Service renewed for 1 year",service:serializeService(updated)});
    } catch(error) {
        res.status(500).json({success:false,message:error.message});
    }
});

/* =====================================================
   DATABASE SYNC APIs
   These keep the existing browser UI compatible while
   making MySQL the permanent shared data store.
===================================================== */

async function safeJson(res, fn){
  try { return await fn(); }
  catch(e){ console.error(e); return res.status(500).json({success:false,message:e.message}); }
}

app.get('/api/sync/products', async (req,res)=>safeJson(res, async()=>{
  const [rows]=await db.query(`SELECT id,name,category,sku,price,sale_price AS salePrice,stock,description,size,colour,image,status,(status='active') AS active,created_at AS createdAt,updated_at AS updatedAt FROM products ORDER BY id DESC`);
  res.json({success:true,data:rows});
}));

app.put('/api/sync/products', async (req,res)=>safeJson(res, async()=>{
  const data=Array.isArray(req.body.data)?req.body.data:[];
  await db.query('START TRANSACTION');
  try{
    const ids=[];
    for(const p of data){
      const id=Number(p.id);
      if(id>0){
        await db.query(`INSERT INTO products (id,name,category,sku,price,sale_price,stock,description,size,colour,image,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),category=VALUES(category),sku=VALUES(sku),price=VALUES(price),sale_price=VALUES(sale_price),stock=VALUES(stock),description=VALUES(description),size=VALUES(size),colour=VALUES(colour),image=VALUES(image),status=VALUES(status)`,[id,p.name||'Product',p.category||'',p.sku||'',Number(p.price||0),p.salePrice===''||p.salePrice==null?null:Number(p.salePrice),Number(p.stock||0),p.description||'',p.size||'',p.colour||'',p.image||'',p.status||'active']);
        ids.push(id);
      }
    }
    if(ids.length) await db.query(`DELETE FROM products WHERE id NOT IN (${ids.map(()=>'?').join(',')})`,ids); else await db.query('DELETE FROM products');
    await db.query('COMMIT'); res.json({success:true,count:data.length});
  }catch(e){await db.query('ROLLBACK');throw e;}
}));

app.get('/api/sync/customers', async(req,res)=>safeJson(res,async()=>{ const [r]=await db.query('SELECT id,name,mobile,email,address,city,state,pincode,created_at AS createdAt FROM customers ORDER BY id DESC'); res.json({success:true,data:r}); }));
app.put('/api/sync/customers', async(req,res)=>safeJson(res,async()=>{
 const data=Array.isArray(req.body.data)?req.body.data:[]; await db.query('START TRANSACTION');
 try{const ids=[]; for(const c of data){const id=Number(c.id); if(id>0){await db.query(`INSERT INTO customers(id,name,mobile,email,address,city,state,pincode) VALUES(?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),mobile=VALUES(mobile),email=VALUES(email),address=VALUES(address),city=VALUES(city),state=VALUES(state),pincode=VALUES(pincode)`,[id,c.name||'Customer',c.mobile||'',c.email||'',c.address||'',c.city||'',c.state||'',c.pincode||'']);ids.push(id)}} if(ids.length) await db.query(`DELETE FROM customers WHERE id NOT IN (${ids.map(()=>'?').join(',')})`,ids); else await db.query('DELETE FROM customers'); await db.query('COMMIT');res.json({success:true});}catch(e){await db.query('ROLLBACK');throw e;}
}));

app.get('/api/sync/orders', async(req,res)=>safeJson(res,async()=>{
 const [orders]=await db.query('SELECT id,customer_id AS customerId,customer_name AS customerName,mobile,email,address,city,state,pincode,notes,payment_method AS paymentMode,payment_status AS paymentStatus,status,subtotal,shipping,total,created_at AS createdAt FROM orders ORDER BY created_at DESC');
 for(const o of orders){ const [items]=await db.query('SELECT product_id AS productId,name,category,sku,price,quantity,total,image FROM order_items WHERE order_id=?',[o.id]); o.products=items; o.customer={name:o.customerName,mobile:o.mobile,email:o.email,address:o.address,city:o.city,state:o.state,pincode:o.pincode}; }
 res.json({success:true,data:orders});
}));
app.put('/api/sync/orders', requireActiveService, async(req,res)=>safeJson(res,async()=>{
 const data=Array.isArray(req.body.data)?req.body.data:[]; await db.query('START TRANSACTION');
 try{
  const ids=[];
  for(const o of data){const id=String(o.id||('TH-'+Date.now())); ids.push(id); const c=o.customer||{}; let customerId=null;
   if(c.name||c.mobile||o.customerName){ const [cr]=await db.query(`INSERT INTO customers(name,mobile,email,address,city,state,pincode) VALUES(?,?,?,?,?,?,?)`,[c.name||o.customerName||'Customer',c.mobile||o.mobile||'',c.email||o.email||'',c.address||o.address||'',c.city||o.city||'',c.state||o.state||'',c.pincode||o.pincode||'']); customerId=cr.insertId; }
   await db.query(`INSERT INTO orders(id,customer_id,customer_name,mobile,email,address,city,state,pincode,notes,payment_method,payment_status,status,subtotal,shipping,total,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE customer_name=VALUES(customer_name),mobile=VALUES(mobile),email=VALUES(email),address=VALUES(address),city=VALUES(city),state=VALUES(state),pincode=VALUES(pincode),notes=VALUES(notes),payment_method=VALUES(payment_method),payment_status=VALUES(payment_status),status=VALUES(status),subtotal=VALUES(subtotal),shipping=VALUES(shipping),total=VALUES(total)`,[id,customerId,c.name||o.customerName||'Customer',c.mobile||o.mobile||'',c.email||o.email||'',c.address||o.address||'',c.city||o.city||'',c.state||o.state||'',c.pincode||o.pincode||'',o.notes||'',o.paymentMode||o.payment_method||'',o.paymentStatus||'Pending',o.status||'Pending',Number(o.subtotal||0),Number(o.shipping||0),Number(o.total||o.grandTotal||o.amount||0),o.createdAt?new Date(o.createdAt):new Date()]);
   await db.query('DELETE FROM order_items WHERE order_id=?',[id]); for(const it of (o.products||o.items||[])){await db.query(`INSERT INTO order_items(order_id,product_id,name,category,sku,price,quantity,total,image) VALUES(?,?,?,?,?,?,?,?,?)`,[id,Number(it.productId||it.id)||null,it.name||'',it.category||'',it.sku||'',Number(it.price||0),Number(it.quantity||1),Number(it.total||((it.price||0)*(it.quantity||1))),it.image||'']);}
  }
  if(ids.length) await db.query(`DELETE FROM orders WHERE id NOT IN (${ids.map(()=>'?').join(',')})`,ids); else await db.query('DELETE FROM orders'); await db.query('COMMIT');res.json({success:true,count:data.length});
 }catch(e){await db.query('ROLLBACK');throw e;}
}));

app.get('/api/sync/coupons', async(req,res)=>safeJson(res,async()=>{const [r]=await db.query('SELECT id,code,discount_type AS discountType,discount_value AS discountValue,min_order AS minOrder,max_discount AS maxDiscount,status,created_at AS createdAt FROM coupons ORDER BY id DESC');res.json({success:true,data:r});}));
app.put('/api/sync/coupons', async(req,res)=>safeJson(res,async()=>{const data=Array.isArray(req.body.data)?req.body.data:[];await db.query('START TRANSACTION');try{const ids=[];for(const c of data){const id=Number(c.id);if(id>0){await db.query(`INSERT INTO coupons(id,code,discount_type,discount_value,min_order,max_discount,status) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE code=VALUES(code),discount_type=VALUES(discount_type),discount_value=VALUES(discount_value),min_order=VALUES(min_order),max_discount=VALUES(max_discount),status=VALUES(status)`,[id,c.code||'',c.discountType||c.discount_type||'percentage',Number(c.discountValue||c.discount||0),Number(c.minOrder||0),c.maxDiscount==null?null:Number(c.maxDiscount),c.status||'active']);ids.push(id)}}if(ids.length)await db.query(`DELETE FROM coupons WHERE id NOT IN (${ids.map(()=>'?').join(',')})`,ids);else await db.query('DELETE FROM coupons');await db.query('COMMIT');res.json({success:true});}catch(e){await db.query('ROLLBACK');throw e;}}));

app.get('/api/sync/reviews', async(req,res)=>safeJson(res,async()=>{const [r]=await db.query('SELECT id,product_id AS productId,customer_name AS customerName,rating,review,status,created_at AS createdAt FROM reviews ORDER BY id DESC');res.json({success:true,data:r});}));
app.put('/api/sync/reviews', async(req,res)=>safeJson(res,async()=>{const data=Array.isArray(req.body.data)?req.body.data:[];await db.query('START TRANSACTION');try{const ids=[];for(const v of data){const id=Number(v.id);if(id>0){await db.query(`INSERT INTO reviews(id,product_id,customer_name,rating,review,status) VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE product_id=VALUES(product_id),customer_name=VALUES(customer_name),rating=VALUES(rating),review=VALUES(review),status=VALUES(status)`,[id,Number(v.productId||v.product_id||0),v.customerName||v.customer_name||'Customer',Number(v.rating||5),v.review||'',v.status||'active']);ids.push(id)}}if(ids.length)await db.query(`DELETE FROM reviews WHERE id NOT IN (${ids.map(()=>'?').join(',')})`,ids);else await db.query('DELETE FROM reviews');await db.query('COMMIT');res.json({success:true});}catch(e){await db.query('ROLLBACK');throw e;}}));

/* =====================================================
   SERVER START
===================================================== */

app.listen(PORT, async () => {

    console.log(
        `🚀 THE TURBAN HOUSE server running on port ${PORT}`
    );

    await connectDatabase();

});
